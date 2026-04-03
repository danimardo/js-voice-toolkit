// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface VoxtralBatchOptions {
  /** API key de Mistral */
  apiKey: string;
  /**
   * Modelo a usar.
   * - 'voxtral-mini-2507' → más rápido, menor coste
   * - 'voxtral-2507'      → mayor precisión
   * Por defecto: 'voxtral-mini-2507'
   */
  model?: 'voxtral-mini-2507' | 'voxtral-2507';
  /** Idioma del audio en formato BCP-47 (ej: "es", "en"). Si se omite, se detecta automáticamente. */
  language?: string;
  /**
   * Tarea a realizar.
   * - 'transcribe' → transcribe el audio en el idioma original
   * - 'translate'  → transcribe y traduce al inglés
   * Por defecto: 'transcribe'
   */
  task?: 'transcribe' | 'translate';
}

export interface VoxtralTranscription {
  /** Texto transcrito */
  text: string;
  /** Idioma detectado (si el modelo lo devuelve) */
  language?: string;
  /** Duración del audio en segundos (si el modelo lo devuelve) */
  duration?: number;
}

const BASE_URL = 'https://api.mistral.ai/v1';

// ─── transcribeAudio ──────────────────────────────────────────────────────────

/**
 * Transcribe un fichero de audio usando Mistral Voxtral.
 * Acepta Blob, File o ArrayBuffer. Formatos soportados: mp3, mp4, wav, m4a, ogg, webm.
 *
 * @example
 * // Desde un input file del navegador
 * const file = inputElement.files[0];
 * const result = await transcribeAudio(file, { apiKey: 'tu-key', language: 'es' });
 * console.log(result.text);
 *
 * @example
 * // Desde un Blob grabado con MediaRecorder
 * const blob = new Blob(audioChunks, { type: 'audio/webm' });
 * const result = await transcribeAudio(blob, { apiKey: 'tu-key' });
 */
export async function transcribeAudio(
  audio: Blob | File | ArrayBuffer,
  options: VoxtralBatchOptions
): Promise<VoxtralTranscription> {
  const {
    apiKey,
    model = 'voxtral-mini-2507',
    language,
    task = 'transcribe',
  } = options;

  const formData = new FormData();

  // Normalizar la entrada a Blob/File para FormData
  if (audio instanceof ArrayBuffer) {
    formData.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
  } else if (audio instanceof File) {
    formData.append('file', audio);
  } else {
    // Blob — infiere extensión desde el tipo MIME
    const ext = audio.type.split('/')[1]?.split(';')[0] ?? 'webm';
    formData.append('file', audio, `audio.${ext}`);
  }

  formData.append('model', model);
  formData.append('response_format', 'json');

  if (language) formData.append('language', language);
  if (task === 'translate') formData.append('task', 'translate');

  const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Voxtral transcription error ${response.status}: ${error}`);
  }

  const data = await response.json() as VoxtralTranscription;
  return data;
}

/**
 * Transcribe y traduce al inglés un fichero de audio.
 * Atajo para `transcribeAudio` con `task: 'translate'`.
 */
export async function translateAudio(
  audio: Blob | File | ArrayBuffer,
  options: Omit<VoxtralBatchOptions, 'task'>
): Promise<VoxtralTranscription> {
  return transcribeAudio(audio, { ...options, task: 'translate' });
}
