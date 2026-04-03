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
