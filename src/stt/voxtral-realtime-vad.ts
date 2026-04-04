// ─── STT en tiempo real con VAD (Voice Activity Detection) ───────────────────
//
// Extiende transcribeLiveRealtime con detección automática de fin de turno:
//
//  1. VAD por RMS — mide la energía de cada chunk PCM para distinguir voz/silencio
//  2. Timer de silencio — cuando hay ≥ N ms de silencio tras hablar, se evalúa el turno
//  3. Capa semántica (rule-based) — ajusta el timer según el texto transcrito:
//       - Frase cerrada (.!?)          → dispara de inmediato
//       - Duda/conector abierto        → extiende el timer
//       - Ambiguo                      → usa el timer base
//  4. onTurnEnd — callback cuando se confirma el fin de turno
//
// La sesión es multi-turno: el micrófono y el WebSocket permanecen abiertos
// entre turnos. Cada turno reinicia el texto acumulado. El usuario puede hablar
// tantas veces como quiera hasta llamar session.stop().

import { MicrophoneCapture } from './voxtral-realtime-client.js';
import type { RealtimeSTTSession } from './voxtral-realtime-client.js';

// ─── Constantes por defecto ───────────────────────────────────────────────────

const DEFAULT_HESITATION_PHRASES = [
  'eh', 'ehm', 'eem', 'mmm', 'mm', 'hmm', 'hm', 'um', 'uh',
  'o sea', 'bueno', 'pues', 'este', 'a ver', 'es que', 'o sea que',
  'y...', 'y…', 'pero...', 'pero…', 'porque...', 'porque…',
  'entonces...', 'entonces…', 'o...', 'o…',
];

// Conectores al final de frase que indican continuación
const OPEN_CONNECTOR_RE =
  /\b(y|pero|porque|que|si|cuando|aunque|o|ni|como|además|también|sin embargo|es decir|o sea|o sea que|y también|y además)\s*[.,]?\s*$/i;

// Signos de puntuación de cierre
const CLOSED_ENDING_RE = /[.!?¡¿]\s*$/;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface RealtimeSTTVADOptions {
  /**
   * URL del endpoint WebSocket del servidor.
   * Desarrollo: 'ws://localhost:5173/ws/stt-realtime'
   * Producción: 'wss://tu-dominio.com/ws/stt-realtime'
   */
  wsUrl: string;
  /** Idioma del audio en BCP-47. Auto-detecta si se omite. */
  language?: string;

  // ─── VAD ────────────────────────────────────────────────────────────────────
  /**
   * Umbral de energía RMS para detectar voz.
   * Valores menores = más sensible (detecta susurros).
   * Valores mayores = menos sensible (ignora ruido de fondo).
   * Por defecto: 0.01 (1% de la amplitud máxima).
   */
  vadEnergyThreshold?: number;
  /**
   * Ms de silencio consecutivos antes de evaluar el fin de turno.
   * Por defecto: 700ms.
   */
  silenceThresholdMs?: number;
  /**
   * Ms adicionales de espera cuando la capa semántica detecta duda o frase abierta.
   * Por defecto: 1500ms.
   */
  silenceExtensionMs?: number;
  /**
   * Ms mínimos de voz detectada antes de activar el VAD.
   * Evita que ruidos cortos (tos, clic) disparen el temporizador.
   * Por defecto: 300ms.
   */
  minSpeechMs?: number;

  // ─── Semántica ───────────────────────────────────────────────────────────────
  /**
   * Lista de palabras/frases de duda al final de la transcripción que extienden
   * el timer de silencio. Distingue entre "el usuario sigue pensando" y "ha terminado".
   * Por defecto: ['eh', 'mmm', 'o sea', 'bueno', 'pues', 'y...', ...]
   */
  hesitationPhrases?: string[];

  // ─── Callbacks ───────────────────────────────────────────────────────────────
  /**
   * Llamado con cada fragmento de transcripción recibido.
   * @param delta       Texto nuevo del evento actual (delta de Voxtral)
   * @param turnText    Texto acumulado del turno actual (se reinicia tras onTurnEnd)
   */
  onTranscript: (delta: string, turnText: string) => void;
  /**
   * Llamado cuando se detecta el fin del turno de habla del usuario.
   * @param finalText   Texto completo del turno (equivale al último valor de turnText)
   */
  onTurnEnd: (finalText: string) => void;
  /** Llamado cuando el servidor está listo y el micrófono activo. */
  onStart?: () => void;
  /** Llamado cuando la sesión se detiene completamente (session.stop()). */
  onStop?: () => void;
  /** Llamado cuando el VAD detecta el inicio de voz (el usuario empieza a hablar). */
  onVoiceStart?: () => void;
  /**
   * Llamado cuando el VAD detecta el inicio del silencio (el usuario para de hablar).
   * El fin de turno aún no se ha confirmado — puede cancelarse si el usuario vuelve a hablar.
   */
  onVoicePause?: () => void;
  /** Callback de error. Si no se define, los errores se loguean por consola. */
  onError?: (error: Error) => void;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/** Calcula el RMS (energía media) de un array de muestras PCM 16-bit normalizadas a [-1, 1]. */
function calculateRMS(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized = samples[i] / 32767;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

type TurnClassification = 'close' | 'hesitate';

/**
 * Clasifica el texto transcrito para decidir si esperar más antes de disparar onTurnEnd.
 * - 'close'    → frase gramaticalmente cerrada → disparar inmediatamente
 * - 'hesitate' → frase abierta o con duda → extender el timer
 */
function classifyTurnEnd(text: string, hesitationPhrases: string[]): TurnClassification {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Comprobar frases de duda al final del texto
  for (const phrase of hesitationPhrases) {
    if (lower.endsWith(phrase.toLowerCase())) return 'hesitate';
  }

  // 2. Comprobar conectores abiertos
  if (OPEN_CONNECTOR_RE.test(lower)) return 'hesitate';

  // 3. Comprobar puntuación de cierre (Voxtral Realtime ya añade puntuación)
  if (CLOSED_ENDING_RE.test(trimmed)) return 'close';

  // 4. Ambiguo → tratar como cierre (el timer base ya sirve de buffer)
  return 'close';
}

// ─── transcribeLiveRealtimeVAD ────────────────────────────────────────────────

/**
 * Inicia una sesión de transcripción en tiempo real con detección automática
 * de fin de turno mediante VAD (Voice Activity Detection) y análisis semántico.
 *
 * La sesión es **multi-turno**: el micrófono y la conexión WebSocket permanecen
 * activos entre turnos. Cada vez que el VAD detecta el fin del turno, llama a
 * `onTurnEnd` con el texto completo y reinicia el acumulador para el siguiente.
 *
 * Llama siempre desde un handler de click (gesto de usuario) para que el
 * navegador conceda el permiso de micrófono inmediatamente.
 *
 * @example
 * // En un componente Svelte:
 * const session = await transcribeLiveRealtimeVAD({
 *   wsUrl: `ws://${window.location.host}/ws/stt-realtime`,
 *   language: 'es',
 *   onTranscript: (_, turnText) => { input = turnText; },
 *   onTurnEnd: (text) => {
 *     input = text;
 *     submitForm();
 *   },
 *   onStart: () => { isRecording = true; },
 *   onStop: () => { isRecording = false; },
 * });
 *
 * // Para detener:
 * session.stop();
 */
export async function transcribeLiveRealtimeVAD(
  options: RealtimeSTTVADOptions,
): Promise<RealtimeSTTSession> {
  const {
    wsUrl,
    language,
    vadEnergyThreshold = 0.01,
    silenceThresholdMs = 700,
    silenceExtensionMs = 1500,
    minSpeechMs = 300,
    hesitationPhrases = DEFAULT_HESITATION_PHRASES,
    onTranscript,
    onTurnEnd,
    onStart,
    onStop,
    onVoiceStart,
    onVoicePause,
    onError,
  } = options;

  // ─── 1. Solicitar micrófono inmediatamente (gesto de usuario) ──────────────
  let micStream: MediaStream;
  try {
    micStream = await MicrophoneCapture.requestStream();
  } catch (e) {
    throw new Error(`No se pudo acceder al micrófono: ${String(e)}`);
  }

  // ─── Estado de sesión ──────────────────────────────────────────────────────
  let mic: MicrophoneCapture | null = null;
  let ws: WebSocket | null = new WebSocket(wsUrl);
  let active = true;
  let turnText = '';          // texto acumulado del turno actual
  let ignoreDeltas = false;   // true durante un breve período post-onTurnEnd
  let pendingTurnEnd = false; // true si el timer disparó pero turnText estaba vacío (latencia Mistral)

  // ─── Estado VAD ────────────────────────────────────────────────────────────
  let voiceActive = false;
  let speechStartTime = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleError = (err: Error): void => {
    if (onError) onError(err);
    else console.error('[js-voice-toolkit] Error VAD STT:', err);
  };

  const cleanup = (): void => {
    mic?.stop();
    mic = null;
    micStream.getTracks().forEach((t) => t.stop());
  };

  // ─── 2. Abrir WebSocket y enviar { type: 'start' } ─────────────────────────
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => {
      ws!.send(JSON.stringify({ type: 'start', language }));
      resolve();
    };
    ws!.onerror = () => reject(new Error('No se pudo conectar al servidor WebSocket'));
  });

  // ─── Lógica de fin de turno ────────────────────────────────────────────────

  function cancelSilenceTimer(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function fireTurnEnd(): void {
    cancelSilenceTimer();
    if (!active) return;
    const text = turnText.trim();

    if (!text) {
      // La transcripción de Mistral aún no ha llegado (latencia de red).
      // Marcar como pendiente: se disparará al recibir el primer delta.
      pendingTurnEnd = true;
      return;
    }

    pendingTurnEnd = false;
    // Breve ventana de ignorado para descartar deltas tardíos de Voxtral
    ignoreDeltas = true;
    turnText = '';
    onTurnEnd(text);
    setTimeout(() => { ignoreDeltas = false; }, 300);
  }

  function scheduleSilenceTimer(extended: boolean): void {
    cancelSilenceTimer();
    const delay = extended ? silenceThresholdMs + silenceExtensionMs : silenceThresholdMs;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (!active) return;

      const classification = classifyTurnEnd(turnText, hesitationPhrases);

      if (classification === 'hesitate' && !extended) {
        // Primera evaluación: duda detectada → esperar más
        scheduleSilenceTimer(true);
      } else {
        // Frase cerrada o segunda evaluación → disparar
        fireTurnEnd();
      }
    }, delay);
  }

  // ─── VAD: analizar cada chunk de audio ─────────────────────────────────────

  function processAudioChunk(chunk: Int16Array): void {
    const rms = calculateRMS(chunk);

    if (rms >= vadEnergyThreshold) {
      // ── Voz detectada ──
      if (!voiceActive) {
        voiceActive = true;
        speechStartTime = Date.now();
        pendingTurnEnd = false; // El usuario volvió a hablar antes de recibir la transcripción
        onVoiceStart?.();
      }
      // Cancelar timer de silencio: el usuario sigue hablando
      if (silenceTimer !== null) {
        cancelSilenceTimer();
      }
    } else {
      // ── Silencio detectado ──
      if (voiceActive) {
        voiceActive = false;
        const speechDuration = Date.now() - speechStartTime;

        if (speechDuration >= minSpeechMs) {
          // Suficiente habla → activar timer de fin de turno
          onVoicePause?.();
          scheduleSilenceTimer(false);
        }
        // Si la voz fue demasiado corta (tos, clic) → ignorar
      }
    }
  }

  // ─── 3. Esperar { type: 'ready' } y arrancar micrófono ────────────────────
  ws.onmessage = async (event: MessageEvent) => {
    let data: { type: string; text?: string; message?: string };
    try {
      data = JSON.parse(event.data as string) as typeof data;
    } catch {
      return;
    }

    if (data.type === 'ready') {
      mic = new MicrophoneCapture();
      try {
        await mic.start((chunk: Int16Array) => {
          // Enviar audio al servidor
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          }
          // Analizar energía para VAD
          processAudioChunk(chunk);
        }, micStream);
        onStart?.();
      } catch (e) {
        handleError(e instanceof Error ? e : new Error(String(e)));
        cleanup();
      }
    } else if (data.type === 'delta' && data.text) {
      if (!ignoreDeltas) {
        turnText += data.text;
        onTranscript(data.text, turnText);

        // El timer disparó cuando turnText estaba vacío (latencia Mistral).
        // Ahora que llegó texto y el VAD confirma silencio, disparar de inmediato.
        if (pendingTurnEnd && !voiceActive && silenceTimer === null) {
          fireTurnEnd();
        }
      }
    } else if (data.type === 'done') {
      // Segmento completado en Voxtral — la lógica de turno la gestiona el VAD
    } else if (data.type === 'error') {
      handleError(new Error(data.message ?? 'Error de transcripción'));
      cleanup();
    }
  };

  ws.onclose = () => {
    if (active) {
      active = false;
      cancelSilenceTimer();
      cleanup();
      onStop?.();
    }
  };

  ws.onerror = () => {
    handleError(new Error('Error de conexión WebSocket'));
  };

  // ─── API pública de la sesión ─────────────────────────────────────────────

  return {
    stop() {
      if (!active) return;
      active = false;
      cancelSilenceTimer();
      mic?.stop();
      mic = null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('end');
      }
      ws?.close();
      ws = null;
      micStream.getTracks().forEach((t) => t.stop());
      onStop?.();
    },
    getAccumulated() {
      return turnText;
    },
    get isActive() {
      return active;
    },
  };
}
