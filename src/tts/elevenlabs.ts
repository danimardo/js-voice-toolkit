// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ElevenLabsTTSOptions {
  /** API key de ElevenLabs */
  apiKey: string;
  /** ID de la voz. Por defecto: Rachel (en-US, natural) */
  voiceId?: string;
  /** Modelo a usar. Por defecto: eleven_multilingual_v2 */
  modelId?: string;
  /** Idioma sugerido al modelo (ej: "es", "en"). Opcional. */
  language?: string;
  /** Estabilidad de la voz (0-1). Por defecto: 0.5 */
  stability?: number;
  /** Similitud con la voz original (0-1). Por defecto: 0.75 */
  similarityBoost?: number;
  /** Devuelve el audio como stream en lugar de Blob completo */
  stream?: boolean;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  labels: Record<string, string>;
}

// ─── Voces predefinidas más usadas ───────────────────────────────────────────

export const ELEVENLABS_VOICES = {
  RACHEL: '21m00Tcm4TlvDq8ikWAM',    // Inglés, voz femenina natural
  DOMI: 'AZnzlk1XvdvUeBnXmlld',      // Inglés, enérgica
  BELLA: 'EXAVITQu4vr4xnSDxMaL',     // Inglés, suave
  ANTONIO: 'ErXwobaYiN019PkySvjV',   // Español, masculino
  CHARLOTTE: 'XB0fDUnXU5powFXDhCwa', // Multilingüe, femenino
} as const;

const BASE_URL = 'https://api.elevenlabs.io/v1';

// ─── textToSpeech ─────────────────────────────────────────────────────────────

/**
 * Convierte texto en audio usando la API de ElevenLabs.
 * Devuelve un Blob de audio (mp3) o un ReadableStream si stream: true.
 *
 * @example
 * const audio = await textToSpeech('Hola mundo', { apiKey: 'tu-key' });
 * const url = URL.createObjectURL(audio);
 * new Audio(url).play();
 */
export async function textToSpeech(
  text: string,
  options: ElevenLabsTTSOptions
): Promise<Blob> {
  const {
    apiKey,
    voiceId = ELEVENLABS_VOICES.CHARLOTTE,
    modelId = 'eleven_multilingual_v2',
    stability = 0.5,
    similarityBoost = 0.75,
  } = options;

  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${error}`);
  }

  return response.blob();
}

/**
 * Convierte texto en audio y devuelve un ReadableStream para reproducción
 * en tiempo real (útil para textos largos).
 *
 * @example
 * const stream = await textToSpeechStream('Texto largo...', { apiKey: 'tu-key' });
 * // Usar con MediaSource API o Web Audio API
 */
export async function textToSpeechStream(
  text: string,
  options: ElevenLabsTTSOptions
): Promise<ReadableStream<Uint8Array>> {
  const {
    apiKey,
    voiceId = ELEVENLABS_VOICES.CHARLOTTE,
    modelId = 'eleven_multilingual_v2',
    stability = 0.5,
    similarityBoost = 0.75,
  } = options;

  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS stream error ${response.status}: ${error}`);
  }

  if (!response.body) {
    throw new Error('ElevenLabs TTS: respuesta sin body');
  }

  return response.body;
}

// ─── WebSocket streaming (tiempo real) ───────────────────────────────────────

export interface ElevenLabsWSOptions extends Omit<ElevenLabsTTSOptions, 'stream'> {
  /**
   * Fragmentos de texto a sintetizar en tiempo real.
   * Puede ser un array de strings o un AsyncIterable (ej: stream de un LLM).
   */
  textChunks: AsyncIterable<string> | string[];
}

/**
 * Convierte fragmentos de texto en audio en tiempo real usando la API WebSocket
 * de ElevenLabs (`/stream-input`). Permite empezar a reproducir audio mientras
 * aún se están enviando fragmentos de texto (mínima latencia).
 *
 * Devuelve un `ReadableStream<Uint8Array>` con los chunks de audio MP3.
 *
 * IMPORTANTE: Solo funciona en entornos con soporte WebSocket (navegador o Node ≥ 18).
 *
 * @example
 * const stream = textToSpeechWebSocketStream({
 *   apiKey: 'tu-key',
 *   textChunks: ['Hola, ', 'esto es ', 'tiempo real.'],
 * });
 * // Usar el ReadableStream con MediaSource API para reproducción progresiva
 */
export function textToSpeechWebSocketStream(
  options: ElevenLabsWSOptions
): ReadableStream<Uint8Array> {
  const {
    apiKey,
    voiceId = ELEVENLABS_VOICES.CHARLOTTE,
    modelId = 'eleven_multilingual_v2',
    stability = 0.5,
    similarityBoost = 0.75,
    textChunks,
  } = options;

  const wsUrl =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
    `?model_id=${modelId}&output_format=mp3_44100_128`;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Primer mensaje: inicialización con API key y ajustes de voz
        ws.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            use_speaker_boost: true,
          },
          xi_api_key: apiKey,
        }));

        // Enviar fragmentos de texto y señal de fin
        (async () => {
          for await (const chunk of textChunks) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ text: chunk, try_trigger_generation: true }));
            }
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ text: '' })); // fin del stream de texto
          }
        })().catch((e) => controller.error(e));
      };

      ws.onmessage = (event) => {
        // Los mensajes pueden llegar como ArrayBuffer (binario) o JSON con audio en base64
        if (event.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(event.data));
          return;
        }

        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data) as {
              audio?: string;
              isFinal?: boolean;
              message?: string;
            };

            if (msg.audio) {
              const binary = atob(msg.audio);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              controller.enqueue(bytes);
            }

            if (msg.isFinal) {
              ws.close();
              try { controller.close(); } catch { /* ya cerrado */ }
            }

            if (msg.message) {
              // ElevenLabs puede enviar mensajes de error en JSON
              controller.error(new Error(`ElevenLabs WS: ${msg.message}`));
              ws.close();
            }
          } catch {
            // mensaje no JSON — ignorar
          }
        }
      };

      ws.onerror = () => {
        controller.error(new Error('ElevenLabs WebSocket: error de conexión'));
      };

      ws.onclose = (event) => {
        if (!event.wasClean && event.code !== 1000) {
          try {
            controller.error(new Error(`ElevenLabs WebSocket cerrado inesperadamente (${event.code})`));
          } catch { /* stream ya cerrado */ }
        } else {
          try { controller.close(); } catch { /* stream ya cerrado */ }
        }
      };
    },

    cancel() {
      // El stream fue cancelado por el consumidor — nada más que hacer
    },
  });
}

/**
 * Obtiene la lista de voces disponibles en la cuenta.
 */
export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const response = await fetch(`${BASE_URL}/voices`, {
    headers: { 'xi-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs listVoices error ${response.status}`);
  }

  const data = await response.json() as { voices: ElevenLabsVoice[] };
  return data.voices;
}

/**
 * Utilidad: convierte un Blob de audio en una URL reproducible y lo reproduce.
 * Solo funciona en navegador.
 *
 * @example
 * const blob = await textToSpeech('Hola', { apiKey: 'tu-key' });
 * await playAudioBlob(blob);
 */
export function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error(`Error reproduciendo audio: ${String(e)}`));
    };
    audio.play().catch(reject);
  });
}
