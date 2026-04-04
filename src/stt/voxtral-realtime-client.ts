// ─── STT en tiempo real: cliente navegador ────────────────────────────────────
//
// Este módulo solo funciona en el navegador. Captura audio PCM 16-bit a 16kHz
// y lo envía en streaming a un servidor WebSocket que conecta con la API
// RealtimeTranscription de Mistral.
//
// El servidor puede ser:
//   - El Vite plugin de js-voice-toolkit/sveltekit (desarrollo)
//   - attachVoxtralWsServer de js-voice-toolkit/sveltekit (producción)
//   - Cualquier servidor WebSocket que entienda el mismo protocolo

// ─── MicrophoneCapture ────────────────────────────────────────────────────────

/**
 * Captura audio PCM 16-bit mono a 16kHz desde el micrófono del usuario.
 * Usa ScriptProcessorNode para máxima compatibilidad entre navegadores.
 *
 * @example
 * const stream = await MicrophoneCapture.requestStream();
 * const mic = new MicrophoneCapture();
 * await mic.start((chunk) => sendOverWebSocket(chunk), stream);
 * // ...
 * mic.stop();
 */
export class MicrophoneCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onChunk: ((chunk: Int16Array) => void) | null = null;

  /**
   * Solicita acceso al micrófono. Llamar siempre desde un gesto directo del
   * usuario (click) para que el navegador muestre el icono de micrófono
   * inmediatamente sin esperar a que la conexión WebSocket esté lista.
   */
  static async requestStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  }

  /**
   * Inicia la captura de audio y llama a `onChunk` con cada fragmento PCM.
   * @param onChunk  Callback que recibe un Int16Array con las muestras PCM
   * @param existingStream  Stream ya obtenido (de requestStream). Si se omite,
   *                        solicita uno nuevo (requiere gesto de usuario).
   */
  async start(
    onChunk: (chunk: Int16Array) => void,
    existingStream?: MediaStream,
  ): Promise<void> {
    this.onChunk = onChunk;
    this.stream = existingStream ?? (await MicrophoneCapture.requestStream());
    this.context = new AudioContext({ sampleRate: 16000 });

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    // ScriptProcessorNode: 2048 muestras ≈ 128ms a 16kHz (potencia de 2 requerida)
    this.processor = this.context.createScriptProcessor(2048, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const clamped = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = Math.round(clamped * 32767);
      }
      this.onChunk?.(int16);
    };

    const source = this.context.createMediaStreamSource(this.stream);
    source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  /** Detiene la captura y libera todos los recursos de audio. */
  stop(): void {
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.context?.close();
    this.context = null;
  }
}

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface RealtimeSTTOptions {
  /**
   * URL del endpoint WebSocket del servidor.
   * Desarrollo (Vite plugin): 'ws://localhost:5173/ws/stt-realtime'
   * Producción: 'wss://tu-dominio.com/ws/stt-realtime'
   */
  wsUrl: string;
  /**
   * Idioma del audio en BCP-47 (ej: "es", "en").
   * Si se omite, Mistral lo detecta automáticamente.
   */
  language?: string;
  /**
   * Callback principal. Se llama con cada delta de texto recibido y el
   * texto acumulado total desde el inicio de la sesión.
   * @param delta       Fragmento de texto del evento actual
   * @param accumulated Texto completo acumulado hasta ahora
   */
  onTranscript: (delta: string, accumulated: string) => void;
  /** Callback de error. Si no se define, los errores se loguean por consola. */
  onError?: (error: Error) => void;
  /** Callback cuando el servidor está listo y el micrófono activo. */
  onStart?: () => void;
  /** Callback cuando la sesión se detiene (por stop() o cierre del servidor). */
  onStop?: () => void;
}

export interface RealtimeSTTSession {
  /** Detiene la sesión, cierra el WebSocket y libera el micrófono. */
  stop: () => void;
  /** Devuelve el texto acumulado hasta el momento. */
  getAccumulated: () => string;
  /** true mientras la sesión está activa. */
  readonly isActive: boolean;
}

// ─── transcribeLiveRealtime ───────────────────────────────────────────────────

/**
 * Inicia una sesión de transcripción en tiempo real usando la API
 * RealtimeTranscription de Mistral vía WebSocket.
 *
 * A diferencia de `transcribeLive` (batch por chunks), esta función envía
 * audio PCM de forma continua al servidor, que lo reenvía a Mistral y devuelve
 * deltas de texto con latencia mínima (~500ms).
 *
 * Requiere un servidor WebSocket compatible. Usa `createVoxtralRealtimePlugin`
 * (dev) o `attachVoxtralWsServer` (prod) de 'js-voice-toolkit/sveltekit'.
 *
 * @example
 * const session = await transcribeLiveRealtime({
 *   wsUrl: 'ws://localhost:5173/ws/stt-realtime',
 *   language: 'es',
 *   onTranscript: (delta, full) => { transcript = full; },
 *   onStart: () => { isRecording = true; },
 *   onStop: () => { isRecording = false; },
 * });
 *
 * // Para detener:
 * session.stop();
 */
export async function transcribeLiveRealtime(
  options: RealtimeSTTOptions,
): Promise<RealtimeSTTSession> {
  const { wsUrl, language, onTranscript, onError, onStart, onStop } = options;

  // Solicitar el micrófono antes de abrir el WebSocket para que el navegador
  // muestre el icono de grabación de inmediato (requiere gesto de usuario).
  let micStream: MediaStream;
  try {
    micStream = await MicrophoneCapture.requestStream();
  } catch (e) {
    throw new Error(`No se pudo acceder al micrófono: ${String(e)}`);
  }

  let mic: MicrophoneCapture | null = null;
  let ws: WebSocket | null = new WebSocket(wsUrl);
  let accumulated = '';
  let active = true;

  const handleError = (err: Error) => {
    if (onError) {
      onError(err);
    } else {
      console.error('[js-voice-toolkit] Error realtime STT:', err);
    }
  };

  const cleanup = () => {
    mic?.stop();
    mic = null;
    micStream.getTracks().forEach((t) => t.stop());
  };

  // Esperar a que el WebSocket abra y enviar { type: 'start' }
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => {
      ws!.send(JSON.stringify({ type: 'start', language }));
      resolve();
    };
    ws!.onerror = () => reject(new Error('No se pudo conectar al servidor WebSocket'));
  });

  // Manejar mensajes entrantes del servidor
  ws.onmessage = async (event: MessageEvent) => {
    let data: { type: string; text?: string; message?: string };
    try {
      data = JSON.parse(event.data as string) as typeof data;
    } catch {
      return;
    }

    if (data.type === 'ready') {
      // Servidor listo → arrancar captura de micrófono
      mic = new MicrophoneCapture();
      try {
        await mic.start((chunk: Int16Array) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          }
        }, micStream);
        onStart?.();
      } catch (e) {
        handleError(e instanceof Error ? e : new Error(String(e)));
        cleanup();
      }
    } else if (data.type === 'delta' && data.text) {
      accumulated += data.text;
      onTranscript(data.text, accumulated);
    } else if (data.type === 'done') {
      // Segmento completado — el texto final ya fue entregado como deltas
    } else if (data.type === 'error') {
      handleError(new Error(data.message ?? 'Error de transcripción'));
      cleanup();
    }
  };

  ws.onclose = () => {
    if (active) {
      active = false;
      cleanup();
      onStop?.();
    }
  };

  ws.onerror = () => {
    handleError(new Error('Error de conexión WebSocket'));
  };

  return {
    stop() {
      if (!active) return;
      active = false;
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
      return accumulated;
    },
    get isActive() {
      return active;
    },
  };
}
