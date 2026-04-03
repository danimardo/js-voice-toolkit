// src/tts/elevenlabs.ts
var ELEVENLABS_VOICES = {
  RACHEL: "21m00Tcm4TlvDq8ikWAM",
  // Inglés, voz femenina natural
  DOMI: "AZnzlk1XvdvUeBnXmlld",
  // Inglés, enérgica
  BELLA: "EXAVITQu4vr4xnSDxMaL",
  // Inglés, suave
  ANTONIO: "ErXwobaYiN019PkySvjV",
  // Español, masculino
  CHARLOTTE: "XB0fDUnXU5powFXDhCwa"
  // Multilingüe, femenino
};
var BASE_URL = "https://api.elevenlabs.io/v1";
async function textToSpeech(text, options) {
  const {
    apiKey,
    voiceId = ELEVENLABS_VOICES.CHARLOTTE,
    modelId = "eleven_multilingual_v2",
    stability = 0.5,
    similarityBoost = 0.75
  } = options;
  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        use_speaker_boost: true
      }
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${error}`);
  }
  return response.blob();
}
async function textToSpeechStream(text, options) {
  const {
    apiKey,
    voiceId = ELEVENLABS_VOICES.CHARLOTTE,
    modelId = "eleven_multilingual_v2",
    stability = 0.5,
    similarityBoost = 0.75
  } = options;
  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        use_speaker_boost: true
      }
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS stream error ${response.status}: ${error}`);
  }
  if (!response.body) {
    throw new Error("ElevenLabs TTS: respuesta sin body");
  }
  return response.body;
}
async function listVoices(apiKey) {
  const response = await fetch(`${BASE_URL}/voices`, {
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs listVoices error ${response.status}`);
  }
  const data = await response.json();
  return data.voices;
}
function playAudioBlob(blob) {
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

// src/stt/voxtral-batch.ts
var BASE_URL2 = "https://api.mistral.ai/v1";
async function transcribeAudio(audio, options) {
  const {
    apiKey,
    model = "voxtral-mini-2507",
    language,
    task = "transcribe"
  } = options;
  const formData = new FormData();
  if (audio instanceof ArrayBuffer) {
    formData.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  } else if (audio instanceof File) {
    formData.append("file", audio);
  } else {
    const ext = audio.type.split("/")[1]?.split(";")[0] ?? "webm";
    formData.append("file", audio, `audio.${ext}`);
  }
  formData.append("model", model);
  formData.append("response_format", "json");
  if (language) formData.append("language", language);
  if (task === "translate") formData.append("task", "translate");
  const response = await fetch(`${BASE_URL2}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`
    },
    body: formData
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Voxtral transcription error ${response.status}: ${error}`);
  }
  const data = await response.json();
  return data;
}
async function translateAudio(audio, options) {
  return transcribeAudio(audio, { ...options, task: "translate" });
}

// src/stt/voxtral-stream.ts
async function transcribeLive(options) {
  const {
    chunkDurationMs = 3e3,
    onTranscript,
    onError,
    onStart,
    onStop,
    ...voxtralOptions
  } = options;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    throw new Error(`No se pudo acceder al micr\xF3fono: ${String(e)}`);
  }
  let accumulated = "";
  let active = true;
  let recorder = null;
  const mimeType = getSupportedMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : void 0);
  recorder.ondataavailable = async (event) => {
    if (!active || event.data.size === 0) return;
    try {
      const result = await transcribeAudio(event.data, voxtralOptions);
      if (result.text.trim()) {
        accumulated += (accumulated ? " " : "") + result.text.trim();
        onTranscript(result.text.trim(), accumulated);
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (onError) {
        onError(error);
      } else {
        console.error("[js-voice-toolkit] Error en transcripci\xF3n de chunk:", error);
      }
    }
  };
  recorder.onstart = () => onStart?.();
  recorder.onstop = () => {
    active = false;
    stream.getTracks().forEach((track) => track.stop());
    onStop?.();
  };
  recorder.start(chunkDurationMs);
  return {
    stop() {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      active = false;
    },
    getAccumulated() {
      return accumulated;
    },
    get isActive() {
      return active;
    }
  };
}
function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return null;
}
export {
  ELEVENLABS_VOICES,
  listVoices,
  playAudioBlob,
  textToSpeech,
  textToSpeechStream,
  transcribeAudio,
  transcribeLive,
  translateAudio
};
//# sourceMappingURL=index.js.map