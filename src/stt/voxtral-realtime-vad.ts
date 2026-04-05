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
  /(?:^|\s)(y|pero|porque|que|si|cuando|aunque|o|ni|como|además|también|sin embargo|es decir|o sea|o sea que|y también|y además)\s*[.,]?\s*$/i;

// Signos de puntuación de cierre
const CLOSED_ENDING_RE = /[.!?¡¿]\s*$/;

// Adjetivos/determinantes al final de frase que anticipan un sustantivo o número pendiente.
// Ej: "correos de las últimas" → el usuario aún no ha dicho "24 horas".
const HANGING_ADJECTIVE_RE =
  /(?:^|\s)(últim[oa]s?|primer[oa]s?|próxim[oa]s?|pasad[oa]s?|siguientes?|anteriores?|recientes?|nuev[oa]s?|viej[oa]s?|importantes?|urgentes?|pendientes?|no leíd[oa]s?|leíd[oa]s?|enviad[oa]s?|recibid[oa]s?)\s*$/i;

// Preposiciones/artículos al final de frase que casi siempre implican continuación.
// Ej: "resumen de", "correos de las".
const HANGING_PREPOSITION_RE =
  /(?:^|\s)(de|del|para|por|con|sin|sobre|entre|hacia|hasta|desde|según|en|a|al)\s*$/i;

const HANGING_ARTICLE_RE =
  /(?:^|\s)(el|la|los|las|un|una|unos|unas|mi|mis|tu|tus|su|sus|este|esta|estos|estas|ese|esa|esos|esas)\s*$/i;

// Verbos copulativos/transitivos al final de frase que claramente esperan un complemento.
// Ej: "la dirección es", "el correo está", "se llama", "quiero que sea".
const HANGING_VERB_RE =
  /(?:^|\s)(es|está|son|están|era|eran|fue|fueron|será|serán|tiene|tienen|tenía|tenían|quiere|quieren|necesita|necesitan|llama|llaman|se\s+llama|llegan?|va|van|hace|hacen|dice|dicen)\s*$/i;

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
  /**
   * Si es true, emite logs de diagnóstico del VAD en consola:
   * RMS, umbral efectivo, cambios de estado y temporizadores.
   * Por defecto: false.
   */
  debugVad?: boolean;

  // ─── Semántica ───────────────────────────────────────────────────────────────
  /**
   * Lista de palabras/frases de duda al final de la transcripción que extienden
   * el timer de silencio. Distingue entre "el usuario sigue pensando" y "ha terminado".
   * Por defecto: ['eh', 'mmm', 'o sea', 'bueno', 'pues', 'y...', ...]
   */
  hesitationPhrases?: string[];
  /**
   * Si es true, usa heurísticas semánticas para extender el cierre de turno
   * cuando la frase parece abierta ("de", "las últimas", "y...", etc.).
   * Si es false, el cierre depende solo de pausas/inactividad de transcripción.
   * Por defecto: true.
   */
  semanticTurnDetection?: boolean;

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

  // 4. Adjetivo/determinante colgante que espera un sustantivo o número
  if (HANGING_ADJECTIVE_RE.test(lower)) return 'hesitate';

  // 5. Preposición o artículo final: la frase sigue abierta
  if (HANGING_PREPOSITION_RE.test(lower) || HANGING_ARTICLE_RE.test(lower)) return 'hesitate';

  // 6. Verbo copulativo/transitivo final que espera un complemento
  if (HANGING_VERB_RE.test(lower)) return 'hesitate';

  // 7. Ambiguo → tratar como cierre (el timer base ya sirve de buffer)
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
    debugVad = false,
    hesitationPhrases = DEFAULT_HESITATION_PHRASES,
    semanticTurnDetection = true,
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
  let firstSpeechTime = 0;         // Inicio de la sesión de voz actual (no se resetea por ruido)
  let consecutiveVoiceChunks = 0;  // Chunks de voz consecutivos para confirmar habla real
  let consecutiveSilentChunks = 0; // Chunks de silencio consecutivos para confirmar pausa real
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let transcriptIdleTimer: ReturnType<typeof setTimeout> | null = null;

  // Chunks consecutivos de voz necesarios para confirmar habla real.
  // 2 chunks × ~128ms = ~256ms. Evita que picos breves de ruido ambiente
  // cancelen el timer de silencio o disparen onVoiceStart erróneamente.
  const VOICE_CONFIRM_CHUNKS = 2;
  // 4 chunks × ~128ms = ~512ms de silencio continuo antes de confirmar VOICE_PAUSE.
  // Con 2 (256ms) se detectaban pausas naturales de coma o respiración como fin de voz.
  const SILENCE_CONFIRM_CHUNKS = 4;

  // Histéresis: para re-activar la voz durante el período de silencio (y cancelar
  // el timer) se exige SILENCE_HYSTERESIS × effectiveThreshold de energía.
  // Evita que ruido ambiente justo por encima del umbral cancele el timer.
  // Valor 2 → el ruido necesita ser 2× más fuerte que el umbral para cancelar.
  const SILENCE_HYSTERESIS = 2.0;

  // ─── Calibración automática de ruido ambiente (en paralelo con el VAD) ──────
  // Rastrea el mínimo RMS visto en los primeros CALIB_CHUNKS chunks. Después
  // de ese período, ajusta effectiveThreshold = max(configurado, mínimo × 3).
  // Corre en paralelo: el VAD está activo desde el primer chunk con el umbral
  // configurado, y se refina automáticamente una vez completada la calibración.
  let calibrationDone = false;
  let calibChunkCount = 0;
  let calibRmsMin = Infinity;
  let calibQuietChunks = 0;
  const CALIB_CHUNKS = 30; // 30 × 128ms ≈ 4 segundos
  const MIN_CALIB_QUIET_CHUNKS = 6; // ~768ms de silencio/ruido real antes de recalibrar
  let effectiveThreshold = vadEnergyThreshold;
  let chunkIndex = 0;

  const debugLog = (message: string): void => {
    if (debugVad) console.log(`[VAD debug] ${message}`);
  };

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
      debugLog('Cancelando silenceTimer');
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function cancelTranscriptIdleTimer(): void {
    if (transcriptIdleTimer !== null) {
      debugLog('Cancelando transcriptIdleTimer');
      clearTimeout(transcriptIdleTimer);
      transcriptIdleTimer = null;
    }
  }

  function fireTurnEnd(): void {
    cancelSilenceTimer();
    cancelTranscriptIdleTimer();
    if (!active) return;
    const text = turnText.trim();
    debugLog(`fireTurnEnd(textLength=${text.length}, pendingTurnEnd=${pendingTurnEnd}, voiceActive=${voiceActive})`);

    if (!text) {
      // La transcripción de Mistral aún no ha llegado (latencia de red).
      // Marcar como pendiente: se disparará al recibir el primer delta.
      pendingTurnEnd = true;
      return;
    }

    pendingTurnEnd = false;
    firstSpeechTime = 0;       // Reiniciar para el siguiente turno
    consecutiveVoiceChunks = 0;
    // Breve ventana de ignorado para descartar deltas tardíos de Voxtral
    ignoreDeltas = true;
    turnText = '';
    onTurnEnd(text);
    setTimeout(() => { ignoreDeltas = false; }, 300);
  }

  function scheduleSilenceTimer(extended: boolean): void {
    cancelSilenceTimer();
    const delay = extended ? silenceThresholdMs + silenceExtensionMs : silenceThresholdMs;
    debugLog(`Programando silenceTimer(delay=${delay}ms, extended=${extended}, text="${turnText.trim()}")`);
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (!active) return;

      const classification = semanticTurnDetection
        ? classifyTurnEnd(turnText, hesitationPhrases)
        : 'close';
      debugLog(`Silence timer expiró(classification=${classification}, extended=${extended}, text="${turnText.trim()}")`);

      if (classification === 'hesitate' && !extended) {
        // Primera evaluación: duda detectada → esperar más
        scheduleSilenceTimer(true);
      } else {
        // Frase cerrada o segunda evaluación → disparar
        fireTurnEnd();
      }
    }, delay);
  }

  function scheduleTranscriptIdleTimer(): void {
    cancelTranscriptIdleTimer();
    const delay = silenceThresholdMs;
    debugLog(`Programando transcriptIdleTimer(delay=${delay}ms, text="${turnText.trim()}")`);
    transcriptIdleTimer = setTimeout(() => {
      transcriptIdleTimer = null;
      if (!active || voiceActive || silenceTimer !== null) return;

      const classification = semanticTurnDetection
        ? classifyTurnEnd(turnText, hesitationPhrases)
        : 'close';
      debugLog(`Transcript idle expiró(classification=${classification}, text="${turnText.trim()}")`);

      if (classification === 'hesitate') {
        scheduleSilenceTimer(true);
      } else {
        fireTurnEnd();
      }
    }, delay);
  }

  // ─── VAD: analizar cada chunk de audio ─────────────────────────────────────

  function processAudioChunk(chunk: Int16Array): void {
    const rms = calculateRMS(chunk);
    chunkIndex++;

    // ── Calibración en paralelo (no bloquea el VAD) ───────────────────────────
    // Rastrea el mínimo RMS durante los primeros ~4 segundos. El mínimo es
    // una buena aproximación del suelo de ruido: incluso si el usuario habla,
    // las pausas inter-silábicas y entre palabras dan valores cercanos al ruido real.
    if (!calibrationDone) {
      calibChunkCount++;
      if (rms < vadEnergyThreshold) {
        calibQuietChunks++;
        if (rms < calibRmsMin) calibRmsMin = rms;
      }
      if (calibChunkCount >= CALIB_CHUNKS) {
        calibrationDone = true;
        if (calibQuietChunks >= MIN_CALIB_QUIET_CHUNKS && Number.isFinite(calibRmsMin)) {
          const newThreshold = Math.max(vadEnergyThreshold, calibRmsMin * 3);
          if (newThreshold > effectiveThreshold) {
            effectiveThreshold = newThreshold;
            debugLog(
              `Calibración aplicada(minRms=${calibRmsMin.toFixed(4)}, quietChunks=${calibQuietChunks}, threshold=${effectiveThreshold.toFixed(4)})`
            );
          }
        } else {
          debugLog(
            `Calibración omitida(quietChunks=${calibQuietChunks}/${MIN_CALIB_QUIET_CHUNKS}, threshold=${effectiveThreshold.toFixed(4)})`
          );
        }
      }
    }

    // Histéresis: durante el período de silencio (timer activo o voiceActive=false)
    // se exige más energía para re-activar la voz que para desactivarla.
    // Esto evita que el ruido ambiente (que está justo por encima del umbral)
    // cancele el timer de silencio repetidamente.
    const voiceOnThreshold = voiceActive
      ? effectiveThreshold                        // voz activa → umbral normal para detectar silencio
      : effectiveThreshold * SILENCE_HYSTERESIS;  // silencio → umbral 2× para re-activar voz

    if (debugVad && (chunkIndex <= 12 || chunkIndex % 10 === 0)) {
      debugLog(
        `chunk=${chunkIndex} rms=${rms.toFixed(4)} threshold=${effectiveThreshold.toFixed(4)} voiceOnThreshold=${voiceOnThreshold.toFixed(4)} voiceActive=${voiceActive} silenceTimer=${silenceTimer !== null}`
      );
    }

    if (rms >= voiceOnThreshold) {
      // ── Energía de voz detectada ──
      consecutiveVoiceChunks++;
      consecutiveSilentChunks = 0;

      if (!voiceActive && consecutiveVoiceChunks >= VOICE_CONFIRM_CHUNKS) {
        // Solo se confirma habla real tras N chunks consecutivos con energía 2×.
        // Evita que ruido ambiente cancele el timer de silencio.
        voiceActive = true;
        consecutiveSilentChunks = 0;
        if (firstSpeechTime === 0) firstSpeechTime = Date.now();
        pendingTurnEnd = false; // El usuario volvió a hablar antes de recibir la transcripción
        cancelSilenceTimer();   // Habla real confirmada → cancelar timer de silencio
        cancelTranscriptIdleTimer();
        debugLog(`VOICE_START(chunk=${chunkIndex}, rms=${rms.toFixed(4)}, speechStart=${firstSpeechTime})`);
        onVoiceStart?.();
      }
    } else {
      // ── Silencio detectado ──
      consecutiveVoiceChunks = 0;
      consecutiveSilentChunks++;

      if (voiceActive) {
        if (consecutiveSilentChunks < SILENCE_CONFIRM_CHUNKS) {
          debugLog(`Silencio candidato(chunk=${chunkIndex}, rms=${rms.toFixed(4)}, count=${consecutiveSilentChunks}/${SILENCE_CONFIRM_CHUNKS})`);
          return;
        }

        voiceActive = false;
        const speechDuration = Date.now() - firstSpeechTime;
        debugLog(`VOICE_PAUSE(chunk=${chunkIndex}, rms=${rms.toFixed(4)}, speechDuration=${speechDuration}ms)`);

        if (speechDuration >= minSpeechMs) {
          // Suficiente habla acumulada → activar timer de fin de turno
          onVoicePause?.();
          scheduleSilenceTimer(false);
        }
        else {
          debugLog(`Silencio ignorado por minSpeechMs(speechDuration=${speechDuration}ms, min=${minSpeechMs}ms)`);
        }
        // Si la voz fue demasiado corta → ignorar (firstSpeechTime se mantiene para el siguiente chunk)
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
        debugLog(`delta="${data.text}" accumulated="${turnText}"`);
        onTranscript(data.text, turnText);

        if (!voiceActive && silenceTimer === null) {
          scheduleTranscriptIdleTimer();
        } else if (!voiceActive && silenceTimer !== null) {
          // Nueva transcripción llega mientras el silenceTimer está corriendo:
          // el usuario sigue hablando (Mistral lo confirma). Resetear el timer
          // para que no dispare prematuramente antes de que Mistral termine.
          debugLog(`Silencio pospuesto por nueva transcripción: "${turnText.trim()}"`);
          scheduleSilenceTimer(false);
        }

        // El timer disparó cuando turnText estaba vacío (latencia Mistral).
        // Ahora que llegó texto, no disparar con el primer delta: esperar
        // inactividad breve de transcripción para evitar fragmentos como "die" o ".com".
        if (pendingTurnEnd && !voiceActive && silenceTimer === null) {
          pendingTurnEnd = false;
          debugLog('pendingTurnEnd resuelto con delta tardío; esperando transcript idle');
          scheduleTranscriptIdleTimer();
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
      cancelTranscriptIdleTimer();
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
      cancelTranscriptIdleTimer();
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
