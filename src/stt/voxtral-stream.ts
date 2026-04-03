// ─── Transcripción en tiempo real ────────────────────────────────────────────
//
// Estrategia: MediaRecorder graba el micrófono en chunks de duración configurable.
// Cada chunk se envía a Voxtral para transcripción. Los resultados se acumulan
// y se notifican al caller mediante callbacks.
//
// IMPORTANTE: Este módulo solo funciona en navegador (requiere MediaRecorder y
// navigator.mediaDevices). No es compatible con Node.js.

import { transcribeAudio } from './voxtral-batch.js';
import type { VoxtralBatchOptions } from './voxtral-batch.js';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface VoxtralStreamOptions extends Omit<VoxtralBatchOptions, 'task'> {
  /**
   * Duración de cada chunk en ms. Chunks más cortos = menor latencia pero
   * mayor coste en llamadas a la API. Por defecto: 3000ms (3 segundos).
   */
  chunkDurationMs?: number;
  /**
   * Callback que recibe el texto transcrito de cada chunk.
   * @param text  Texto del chunk actual
   * @param accumulated Texto acumulado desde el inicio de la sesión
   */
  onTranscript: (text: string, accumulated: string) => void;
  /** Callback de error. Si no se define, los errores se lanzan como excepciones. */
  onError?: (error: Error) => void;
  /** Callback cuando la sesión arranca y el micrófono está activo */
  onStart?: () => void;
  /** Callback cuando la sesión se detiene */
  onStop?: () => void;
}

export interface VoxtralStreamSession {
  /** Detiene la grabación y la transcripción */
  stop: () => void;
  /** Devuelve el texto acumulado hasta el momento */
  getAccumulated: () => string;
  /** Estado actual de la sesión */
  readonly isActive: boolean;
}

// ─── transcribeLive ───────────────────────────────────────────────────────────

/**
 * Inicia la transcripción en tiempo real desde el micrófono usando Voxtral.
 * Graba en chunks y transcribe cada uno de forma independiente.
 *
 * Devuelve una sesión que puedes detener llamando a `session.stop()`.
 *
 * @example
 * const session = await transcribeLive({
 *   apiKey: 'tu-key',
 *   language: 'es',
 *   chunkDurationMs: 4000,
 *   onTranscript: (chunk, full) => {
 *     console.log('Chunk:', chunk);
 *     console.log('Texto completo:', full);
 *   },
 *   onError: (err) => console.error(err),
 * });
 *
 * // Más tarde...
 * session.stop();
 */
export async function transcribeLive(
  options: VoxtralStreamOptions
): Promise<VoxtralStreamSession> {
  const {
    chunkDurationMs = 3000,
    onTranscript,
    onError,
    onStart,
    onStop,
    ...voxtralOptions
  } = options;

  // Solicitar acceso al micrófono
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    throw new Error(`No se pudo acceder al micrófono: ${String(e)}`);
  }

  let accumulated = '';
  let active = true;
  let recorder: MediaRecorder | null = null;

  // Detectar formato soportado por el navegador
  const mimeType = getSupportedMimeType();

  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = async (event) => {
    if (!active || event.data.size === 0) return;

    try {
      const result = await transcribeAudio(event.data, voxtralOptions);
      if (result.text.trim()) {
        accumulated += (accumulated ? ' ' : '') + result.text.trim();
        onTranscript(result.text.trim(), accumulated);
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (onError) {
        onError(error);
      } else {
        console.error('[js-voice-toolkit] Error en transcripción de chunk:', error);
      }
    }
  };

  recorder.onstart = () => onStart?.();

  recorder.onstop = () => {
    active = false;
    stream.getTracks().forEach(track => track.stop());
    onStop?.();
  };

  // Arrancar la grabación en chunks
  recorder.start(chunkDurationMs);

  return {
    stop() {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      active = false;
    },
    getAccumulated() {
      return accumulated;
    },
    get isActive() {
      return active;
    },
  };
}

// ─── Utilidades internas ──────────────────────────────────────────────────────

function getSupportedMimeType(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return null;
}
