// ─── Manejador WebSocket de Voxtral Realtime (servidor Node.js) ───────────────
//
// Protocolo cliente → servidor:
//   - Texto JSON: { type: 'start', language?: string }  → inicia sesión
//   - Binario:    Uint8Array con muestras PCM 16-bit     → audio continuo
//   - Texto:      'end'                                  → fin del audio
//
// Protocolo servidor → cliente:
//   - { type: 'ready' }             → servidor conectado con Mistral, listo
//   - { type: 'delta', text }       → fragmento de transcripción
//   - { type: 'done',  text }       → segmento completado
//   - { type: 'error', message }    → error fatal

import {
  RealtimeTranscription,
  AudioEncoding,
} from '@mistralai/mistralai/extra/realtime/index.js';
import type { RealtimeEvent } from '@mistralai/mistralai/extra/realtime/index.js';
import type { TranscriptionStreamTextDelta } from '@mistralai/mistralai/models/components/transcriptionstreamtextdelta.js';
import type { TranscriptionStreamDone } from '@mistralai/mistralai/models/components/transcriptionstreamdone.js';
import type { RealtimeTranscriptionError } from '@mistralai/mistralai/models/components/realtimetranscriptionerror.js';
import type { WebSocket } from 'ws';

// ─── Constantes ───────────────────────────────────────────────────────────────

const REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602';

const AUDIO_FORMAT = {
  encoding: AudioEncoding.PcmS16le,
  sampleRate: 16000,
} as const;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface VoxtralWsHandlerOptions {
  /** API key de Mistral */
  apiKey: string;
  /**
   * Idioma predeterminado (BCP-47, ej: "es").
   * El cliente puede sobrescribirlo en { type: 'start', language }.
   * Si ninguno lo especifica, Mistral detecta el idioma automáticamente.
   */
  language?: string;
  /**
   * Latencia objetivo en ms para el streaming (sugerido a la API).
   * Por defecto: 480.
   */
  targetStreamingDelayMs?: number;
}

// ─── Type guards para eventos de Mistral ─────────────────────────────────────

function isTextDelta(e: RealtimeEvent): e is TranscriptionStreamTextDelta {
  return e.type === 'transcription.text.delta';
}

function isDone(e: RealtimeEvent): e is TranscriptionStreamDone {
  return e.type === 'transcription.done';
}

function isError(e: RealtimeEvent): e is RealtimeTranscriptionError {
  return e.type === 'error';
}

// ─── handleVoxtralWsConnection ────────────────────────────────────────────────

/**
 * Gestiona una conexión WebSocket individual y la conecta con la API
 * RealtimeTranscription de Mistral. Llamar una vez por cada cliente conectado.
 *
 * @example
 * wss.on('connection', (ws) => {
 *   handleVoxtralWsConnection(ws, { apiKey: process.env.MISTRAL_API_KEY! });
 * });
 */
export function handleVoxtralWsConnection(
  ws: WebSocket,
  options: VoxtralWsHandlerOptions,
): void {
  const { apiKey, targetStreamingDelayMs = 480 } = options;

  const audioQueue: Uint8Array[] = [];
  let resolveNext: ((chunk: Uint8Array | null) => void) | null = null;
  let ended = false;

  const sendJson = (obj: unknown): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  // Generador asíncrono que entrega chunks de audio en orden de llegada
  function createAudioStream() {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        while (!ended) {
          if (audioQueue.length > 0) {
            yield audioQueue.shift()!;
          } else {
            const chunk = await new Promise<Uint8Array | null>((resolve) => {
              resolveNext = resolve;
            });
            if (chunk !== null) yield chunk;
          }
        }
        while (audioQueue.length > 0) {
          yield audioQueue.shift()!;
        }
      },
    };
  }

  /**
   * Procesa un evento del stream de Mistral.
   * @returns false si se debe detener la iteración (error fatal)
   */
  function handleEvent(event: RealtimeEvent): boolean {
    if (isTextDelta(event)) {
      sendJson({ type: 'delta', text: event.text });
    } else if (isDone(event)) {
      sendJson({ type: 'done', text: event.text });
      // Sin break: Mistral emite eventos por segmentos, continuamos
    } else if (isError(event)) {
      const errMsg = event.error?.message ?? JSON.stringify(event);
      sendJson({ type: 'error', message: errMsg });
      return false;
    }
    return true;
  }

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      if (!isBinary) {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

        if (text.startsWith('{')) {
          const msg = JSON.parse(text) as { type: string; language?: string };

          if (msg.type === 'start') {
            const language = msg.language ?? options.language;
            sendJson({ type: 'ready' });

            void (async () => {
              let connection: Awaited<ReturnType<RealtimeTranscription['connect']>> | null = null;
              try {
                const voxtral = new RealtimeTranscription({ apiKey });

                // El SDK acepta opciones extra en runtime (language, targetStreamingDelayMs)
                // aunque sus tipos TypeScript no las declaran aún.
                const connectOpts = {
                  audioFormat: AUDIO_FORMAT,
                  targetStreamingDelayMs,
                  ...(language ? { language } : {}),
                } as Parameters<RealtimeTranscription['connect']>[1];

                connection = await voxtral.connect(REALTIME_MODEL, connectOpts);

                // Tarea paralela: alimentar el stream de audio al modelo
                const audioTask = (async () => {
                  for await (const chunk of createAudioStream()) {
                    if (connection!.isClosed) break;
                    await connection!.sendAudio(chunk);
                  }
                  if (!connection!.isClosed) {
                    await connection!.flushAudio();
                    await connection!.endAudio();
                  }
                })();

                // Recibir y retransmitir eventos de transcripción
                for await (const event of connection) {
                  if (!handleEvent(event)) break;
                }

                await audioTask;
              } catch (err) {
                const message = err instanceof Error ? err.message : 'Error desconocido';
                console.error('[js-voice-toolkit] Error en sesión Mistral:', message);
                sendJson({ type: 'error', message });
              } finally {
                try {
                  if (connection && !connection.isClosed) {
                    await connection.close();
                  }
                } catch {
                  // Ignorar errores al cerrar la conexión Mistral
                }
                try {
                  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                    ws.close();
                  }
                } catch {
                  // Ignorar errores al cerrar el WebSocket cliente
                }
              }
            })();
          }
          return;
        }

        if (text === 'end') {
          ended = true;
          resolveNext?.(null);
          resolveNext = null;
        }
        return;
      }

      // Frame binario: chunk de audio PCM
      const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (resolveNext) {
        resolveNext(chunk);
        resolveNext = null;
      } else {
        audioQueue.push(chunk);
      }
    } catch (err) {
      console.error('[js-voice-toolkit] Error procesando mensaje WebSocket:', err);
    }
  });

  ws.on('close', () => {
    ended = true;
    resolveNext?.(null);
    resolveNext = null;
  });

  ws.on('error', (err) => {
    console.error('[js-voice-toolkit] Error en WebSocket:', err);
  });
}
