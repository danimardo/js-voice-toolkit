interface ElevenLabsTTSOptions {
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
interface ElevenLabsVoice {
    voice_id: string;
    name: string;
    labels: Record<string, string>;
}
declare const ELEVENLABS_VOICES: {
    readonly RACHEL: "21m00Tcm4TlvDq8ikWAM";
    readonly DOMI: "AZnzlk1XvdvUeBnXmlld";
    readonly BELLA: "EXAVITQu4vr4xnSDxMaL";
    readonly ANTONIO: "ErXwobaYiN019PkySvjV";
    readonly CHARLOTTE: "XB0fDUnXU5powFXDhCwa";
};
/**
 * Convierte texto en audio usando la API de ElevenLabs.
 * Devuelve un Blob de audio (mp3) o un ReadableStream si stream: true.
 *
 * @example
 * const audio = await textToSpeech('Hola mundo', { apiKey: 'tu-key' });
 * const url = URL.createObjectURL(audio);
 * new Audio(url).play();
 */
declare function textToSpeech(text: string, options: ElevenLabsTTSOptions): Promise<Blob>;
/**
 * Convierte texto en audio y devuelve un ReadableStream para reproducción
 * en tiempo real (útil para textos largos).
 *
 * @example
 * const stream = await textToSpeechStream('Texto largo...', { apiKey: 'tu-key' });
 * // Usar con MediaSource API o Web Audio API
 */
declare function textToSpeechStream(text: string, options: ElevenLabsTTSOptions): Promise<ReadableStream<Uint8Array>>;
/**
 * Obtiene la lista de voces disponibles en la cuenta.
 */
declare function listVoices(apiKey: string): Promise<ElevenLabsVoice[]>;
/**
 * Utilidad: convierte un Blob de audio en una URL reproducible y lo reproduce.
 * Solo funciona en navegador.
 *
 * @example
 * const blob = await textToSpeech('Hola', { apiKey: 'tu-key' });
 * await playAudioBlob(blob);
 */
declare function playAudioBlob(blob: Blob): Promise<void>;

interface VoxtralBatchOptions {
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
interface VoxtralTranscription {
    /** Texto transcrito */
    text: string;
    /** Idioma detectado (si el modelo lo devuelve) */
    language?: string;
    /** Duración del audio en segundos (si el modelo lo devuelve) */
    duration?: number;
}
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
declare function transcribeAudio(audio: Blob | File | ArrayBuffer, options: VoxtralBatchOptions): Promise<VoxtralTranscription>;
/**
 * Transcribe y traduce al inglés un fichero de audio.
 * Atajo para `transcribeAudio` con `task: 'translate'`.
 */
declare function translateAudio(audio: Blob | File | ArrayBuffer, options: Omit<VoxtralBatchOptions, 'task'>): Promise<VoxtralTranscription>;

interface VoxtralStreamOptions extends Omit<VoxtralBatchOptions, 'task'> {
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
interface VoxtralStreamSession {
    /** Detiene la grabación y la transcripción */
    stop: () => void;
    /** Devuelve el texto acumulado hasta el momento */
    getAccumulated: () => string;
    /** Estado actual de la sesión */
    readonly isActive: boolean;
}
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
declare function transcribeLive(options: VoxtralStreamOptions): Promise<VoxtralStreamSession>;

export { ELEVENLABS_VOICES, type ElevenLabsTTSOptions, type ElevenLabsVoice, type VoxtralBatchOptions, type VoxtralStreamOptions, type VoxtralStreamSession, type VoxtralTranscription, listVoices, playAudioBlob, textToSpeech, textToSpeechStream, transcribeAudio, transcribeLive, translateAudio };
