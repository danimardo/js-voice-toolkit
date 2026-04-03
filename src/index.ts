// ─── TTS: Texto → Voz ────────────────────────────────────────────────────────
export {
  textToSpeech,
  textToSpeechStream,
  listVoices,
  playAudioBlob,
  ELEVENLABS_VOICES,
} from './tts/elevenlabs.js';

export type {
  ElevenLabsTTSOptions,
  ElevenLabsVoice,
} from './tts/elevenlabs.js';

// ─── STT: Voz → Texto (batch) ─────────────────────────────────────────────────
export {
  transcribeAudio,
  translateAudio,
} from './stt/voxtral-batch.js';

export type {
  VoxtralBatchOptions,
  VoxtralTranscription,
} from './stt/voxtral-batch.js';

// ─── STT: Voz → Texto (tiempo real) ──────────────────────────────────────────
export {
  transcribeLive,
} from './stt/voxtral-stream.js';

export type {
  VoxtralStreamOptions,
  VoxtralStreamSession,
} from './stt/voxtral-stream.js';
