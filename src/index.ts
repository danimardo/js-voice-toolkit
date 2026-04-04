// ─── TTS: Texto → Voz ────────────────────────────────────────────────────────
export {
  textToSpeech,
  textToSpeechStream,
  textToSpeechWebSocketStream,
  listVoices,
  playAudioBlob,
  ELEVENLABS_VOICES,
} from './tts/elevenlabs.js';

export type {
  ElevenLabsTTSOptions,
  ElevenLabsVoice,
  ElevenLabsWSOptions,
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

// ─── STT: Voz → Texto (streaming por chunks, navegador) ──────────────────────
export {
  transcribeLive,
} from './stt/voxtral-stream.js';

export type {
  VoxtralStreamOptions,
  VoxtralStreamSession,
} from './stt/voxtral-stream.js';

// ─── STT: Voz → Texto (tiempo real vía WebSocket, navegador) ─────────────────
export {
  MicrophoneCapture,
  transcribeLiveRealtime,
} from './stt/voxtral-realtime-client.js';

export type {
  RealtimeSTTOptions,
  RealtimeSTTSession,
} from './stt/voxtral-realtime-client.js';
