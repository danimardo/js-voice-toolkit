# js-voice-toolkit

> Librería para TTS (ElevenLabs) y STT en tiempo real y batch (Mistral Voxtral).

[![License](https://img.shields.io/npm/l/js-voice-toolkit)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![GitHub](https://img.shields.io/badge/source-github-black)](https://github.com/danimardo/js-voice-toolkit)

> **Versión actual**: 0.2.0 — STT tiempo real con Mistral Voxtral Realtime API

## Índice

- [Características](#características)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [Guías Rápidas](#guías-rápidas)
  - [Text-to-Speech (TTS)](#text-to-speech-tts)
  - [STT Batch](#stt-batch)
  - [STT Streaming por Chunks](#stt-streaming-por-chunks)
  - [STT Tiempo Real (Voxtral Realtime)](#stt-tiempo-real-voxtral-realtime)
- [Integración SvelteKit](#integración-sveltekit)
  - [Desarrollo (Vite plugin)](#desarrollo-vite-plugin)
  - [Producción (servidor personalizado)](#producción-servidor-personalizado)
- [Referencia de API](#referencia-de-api)
- [Ejemplos Completos](#ejemplos-completos)
- [Buenas Prácticas](#buenas-prácticas)
- [Solución de Problemas](#solución-de-problemas)

---

## Características

### Text-to-Speech (ElevenLabs)
- Voces naturales con ElevenLabs API
- Soporte multilingüe con modelo `eleven_multilingual_v2`
- Tres modos de streaming: batch, HTTP stream y WebSocket
- Control de voz: estabilidad, similitud y boost
- Reproducción directa con utilidad integrada

### Speech-to-Text (Mistral Voxtral)

| Modo | Función | Latencia | Requisitos |
|------|---------|----------|-----------|
| Batch | `transcribeAudio` | Alta | Solo servidor o cliente con API key |
| Streaming chunks | `transcribeLive` | Media (~3s) | Solo navegador |
| **Tiempo real** | `transcribeLiveRealtime` | **Baja (~500ms)** | Navegador + servidor WebSocket |

### Características Técnicas
- **Subpath agnóstico** (`js-voice-toolkit`): TTS + STT batch + STT chunks. Funciona en Vanilla JS, React, Vue, Svelte, Node.js.
- **Subpath SvelteKit** (`js-voice-toolkit/sveltekit`): addon de servidor que integra el WebSocket de Voxtral Realtime en SvelteKit sin proceso separado.
- TypeScript de primera clase: tipos incluidos en ambos subpaths.

---

## Instalación

### Desde GitHub
```bash
npm install github:danimardo/js-voice-toolkit
```

### Desde directorio local (desarrollo)
```bash
npm install file:../js-voice-toolkit
```

### Para el subpath `/sveltekit` también necesitas
```bash
npm install ws
```
> `ws` y `@mistralai/mistralai` son dependencias de `js-voice-toolkit` y se instalan automáticamente.

---

## Configuración

Crea un archivo `.env` en la raíz de tu proyecto:

```env
ELEVENLABS_API_KEY=tu-elevenlabs-api-key
MISTRAL_API_KEY=tu-mistral-api-key
```

> **Importante**: Nunca expongas las API keys en código del cliente. Úsalas solo en el servidor.

---

## Guías Rápidas

### Text-to-Speech (TTS)

```typescript
import { textToSpeech, playAudioBlob } from 'js-voice-toolkit';

const blob = await textToSpeech('Hola, ¿cómo estás?', {
  apiKey: process.env.ELEVENLABS_API_KEY!,
  voiceId: 'XB0fDUnXU5powFXDhCwa' // Charlotte (multilingüe)
});

await playAudioBlob(blob); // Solo navegador
```

### STT Batch

Transcripción de un archivo de audio completo. Requiere API key en el servidor.

```typescript
import { transcribeAudio } from 'js-voice-toolkit';

const result = await transcribeAudio(audioFile, {
  apiKey: process.env.MISTRAL_API_KEY!,
  language: 'es',
  model: 'voxtral-mini-2507'
});

console.log(result.text);
```

### STT Streaming por Chunks

El navegador graba el micrófono en chunks de N segundos y transcribe cada uno.
No requiere servidor WebSocket, pero la latencia depende de `chunkDurationMs`.

```typescript
import { transcribeLive } from 'js-voice-toolkit';

// ⚠️ Llamar desde un gesto de usuario (click)
const session = await transcribeLive({
  apiKey: 'tu-mistral-api-key', // ⚠️ Esto expone la key al cliente
  language: 'es',
  chunkDurationMs: 3000,
  onTranscript: (chunk, full) => {
    console.log('Texto completo:', full);
  },
  onStart: () => console.log('Grabando...'),
  onStop: () => console.log('Parado'),
});

// Para detener:
session.stop();
```

> **Nota de seguridad**: `transcribeLive` llama directamente a la API de Mistral desde el navegador, por lo que la API key queda expuesta. Para producción, usa `transcribeLiveRealtime` con un servidor proxy.

### STT Tiempo Real (Voxtral Realtime)

Transcripción con latencia mínima (~500ms) usando la API WebSocket de Mistral.
La API key permanece en el servidor. Requiere el addon de servidor de SvelteKit
(u otro servidor WebSocket compatible).

**Paso 1**: Configura el servidor WebSocket (ver [Integración SvelteKit](#integración-sveltekit)).

**Paso 2**: En el componente cliente (navegador):

```typescript
import { transcribeLiveRealtime, VOXTRAL_WS_PATH } from 'js-voice-toolkit';

// VOXTRAL_WS_PATH = '/ws/stt-realtime'
// ⚠️ Llamar desde un gesto de usuario (click)
const session = await transcribeLiveRealtime({
  wsUrl: `ws://${window.location.host}${VOXTRAL_WS_PATH}`,
  language: 'es',
  onTranscript: (delta, accumulated) => {
    transcript = accumulated; // actualizar estado reactivo
  },
  onStart: () => { isRecording = true; },
  onStop: () => { isRecording = false; },
  onError: (err) => console.error(err),
});

// Para detener:
session.stop();
console.log('Transcripción final:', session.getAccumulated());
```

---

## Integración SvelteKit

El subpath `js-voice-toolkit/sveltekit` proporciona dos herramientas para integrar el servidor WebSocket de Voxtral Realtime en SvelteKit **sin proceso Node.js adicional**.

### Desarrollo (Vite plugin)

Adjunta el servidor WebSocket al servidor HTTP de Vite durante `vite dev`.

```typescript
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { createVoxtralRealtimePlugin } from 'js-voice-toolkit/sveltekit';
import { config } from 'dotenv';

config(); // carga .env para tener MISTRAL_API_KEY disponible en vite.config

export default defineConfig({
  plugins: [
    sveltekit(),
    createVoxtralRealtimePlugin({
      apiKey: process.env.MISTRAL_API_KEY!,
      language: 'es',           // opcional — Mistral también auto-detecta
    }),
  ],
});
```

Con esto, durante desarrollo el WebSocket está disponible automáticamente en:
`ws://localhost:5173/ws/stt-realtime`

### Producción (servidor personalizado)

En producción, SvelteKit con `adapter-node` genera `build/handler.js`. Crea un
`server.js` en la raíz del proyecto que lo envuelve y añade el WebSocket:

```javascript
// server.js (raíz del proyecto)
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { attachVoxtralWsServer } from 'js-voice-toolkit/sveltekit';

const server = createServer(handler);

attachVoxtralWsServer(server, {
  apiKey: process.env.MISTRAL_API_KEY,
  language: 'es',
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
```

Actualiza los scripts de `package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "start": "node server.js"
  }
}
```

El WebSocket estará en el mismo puerto y host que la app:
`wss://tu-dominio.com/ws/stt-realtime`

---

## Referencia de API

### TTS (ElevenLabs)

#### `textToSpeech(text, options)` → `Promise<Blob>`

Convierte texto en audio MP3.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `text` | `string` | Texto a sintetizar |
| `options.apiKey` | `string` | API key de ElevenLabs |
| `options.voiceId` | `string?` | ID de voz (por defecto: Charlotte) |
| `options.modelId` | `string?` | Modelo (por defecto: `eleven_multilingual_v2`) |
| `options.stability` | `number?` | 0–1, por defecto 0.5 |
| `options.similarityBoost` | `number?` | 0–1, por defecto 0.75 |

#### `textToSpeechStream(text, options)` → `Promise<ReadableStream<Uint8Array>>`

Igual que `textToSpeech` pero devuelve un stream para reproducción progresiva.

#### `textToSpeechWebSocketStream(options)` → `ReadableStream<Uint8Array>`

Streaming en tiempo real usando WebSocket de ElevenLabs. Ideal con LLMs.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `options.textChunks` | `AsyncIterable<string> \| string[]` | Fragmentos de texto |
| `options.apiKey` | `string` | API key de ElevenLabs |

#### `listVoices(apiKey)` → `Promise<ElevenLabsVoice[]>`

Lista las voces disponibles en tu cuenta de ElevenLabs.

#### `playAudioBlob(blob)` → `Promise<void>`

Reproduce un Blob de audio. Solo navegador.

#### `ELEVENLABS_VOICES`

```typescript
ELEVENLABS_VOICES.RACHEL    // "21m00Tcm4TlvDq8ikWAM" — inglés, femenina
ELEVENLABS_VOICES.ANTONIO   // "ErXwobaYiN019PkySvjV" — español, masculina
ELEVENLABS_VOICES.CHARLOTTE // "XB0fDUnXU5powFXDhCwa" — multilingüe, femenina
```

---

### STT Batch (Mistral Voxtral)

#### `transcribeAudio(audio, options)` → `Promise<VoxtralTranscription>`

Transcribe un archivo de audio completo.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `audio` | `Blob \| File \| ArrayBuffer` | Archivo de audio |
| `options.apiKey` | `string` | API key de Mistral |
| `options.model` | `string?` | `'voxtral-mini-2507'` (por defecto) o `'voxtral-2507'` |
| `options.language` | `string?` | BCP-47, ej: `"es"`. Auto-detecta si se omite |
| `options.task` | `string?` | `'transcribe'` (por defecto) o `'translate'` |

**Respuesta** `VoxtralTranscription`:
- `text: string` — texto transcrito
- `language?: string` — idioma detectado
- `duration?: number` — duración en segundos

#### `translateAudio(audio, options)` → `Promise<VoxtralTranscription>`

Atajo para `transcribeAudio` con `task: 'translate'` (transcribe y traduce al inglés).

---

### STT Streaming por Chunks

#### `transcribeLive(options)` → `Promise<VoxtralStreamSession>`

Inicia transcripción en tiempo real desde el micrófono por chunks de audio.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `options.apiKey` | `string` | API key de Mistral (expuesta en cliente) |
| `options.language` | `string?` | BCP-47 |
| `options.chunkDurationMs` | `number?` | Ms por chunk, por defecto 3000 |
| `options.onTranscript` | `(chunk, full) => void` | Callback requerido |
| `options.onError` | `(error) => void` | Callback de error |
| `options.onStart` | `() => void` | Micrófono activo |
| `options.onStop` | `() => void` | Sesión detenida |

**Retorna** `VoxtralStreamSession`:
- `stop()` — detiene la sesión
- `getAccumulated()` — texto acumulado
- `isActive: boolean` — estado actual

---

### STT Tiempo Real (Voxtral Realtime)

#### `transcribeLiveRealtime(options)` → `Promise<RealtimeSTTSession>`

Inicia transcripción en tiempo real con latencia mínima via WebSocket.
Requiere un servidor WebSocket compatible (ver addon `/sveltekit`).

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `options.wsUrl` | `string` | URL del WebSocket del servidor |
| `options.language` | `string?` | BCP-47. Auto-detecta si se omite |
| `options.onTranscript` | `(delta, accumulated) => void` | Callback requerido |
| `options.onError` | `(error) => void` | Callback de error |
| `options.onStart` | `() => void` | Servidor listo, mic activo |
| `options.onStop` | `() => void` | Sesión detenida |

**Retorna** `RealtimeSTTSession`:
- `stop()` — detiene la sesión y libera el micrófono
- `getAccumulated()` — texto acumulado
- `isActive: boolean` — estado actual

#### `MicrophoneCapture`

Clase para captura de audio PCM 16-bit mono a 16kHz. Usada internamente por
`transcribeLiveRealtime`, pero exportada para integraciones personalizadas.

```typescript
// Solicitar stream (dentro de gesto de usuario)
const stream = await MicrophoneCapture.requestStream();

const mic = new MicrophoneCapture();
await mic.start((chunk: Int16Array) => {
  // chunk contiene muestras PCM 16-bit
  sendToServer(chunk);
}, stream);

mic.stop(); // libera recursos
```

---

### Addon SvelteKit (`js-voice-toolkit/sveltekit`)

#### `createVoxtralRealtimePlugin(options)` → Plugin de Vite

Plugin de Vite para desarrollo. Adjunta el servidor WebSocket de Voxtral al
servidor HTTP de Vite, sin proceso adicional.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `options.apiKey` | `string` | API key de Mistral |
| `options.language` | `string?` | Idioma predeterminado servidor |
| `options.targetStreamingDelayMs` | `number?` | Latencia objetivo, por defecto 480 |

#### `attachVoxtralWsServer(httpServer, options)` → `void`

Adjunta el servidor WebSocket a un servidor HTTP de Node.js existente.
Usar en el servidor de producción personalizado de SvelteKit.

#### `VOXTRAL_WS_PATH`

Constante con la ruta WebSocket estándar: `'/ws/stt-realtime'`.

---

## Ejemplos Completos

### Componente Svelte con STT en Tiempo Real

```svelte
<script lang="ts">
  import { transcribeLiveRealtime, VOXTRAL_WS_PATH } from 'js-voice-toolkit';

  let transcript = $state('');
  let isRecording = $state(false);
  let session: Awaited<ReturnType<typeof transcribeLiveRealtime>> | null = null;

  async function toggleRecording() {
    if (isRecording) {
      session?.stop();
      session = null;
      return;
    }

    try {
      session = await transcribeLiveRealtime({
        wsUrl: `ws://${window.location.host}${VOXTRAL_WS_PATH}`,
        language: 'es',
        onTranscript: (_, full) => { transcript = full; },
        onStart: () => { isRecording = true; },
        onStop: () => { isRecording = false; },
        onError: (err) => console.error('[STT]', err),
      });
    } catch (err) {
      console.error('Error iniciando STT:', err);
    }
  }
</script>

<button onclick={toggleRecording}>
  {isRecording ? '⏹ Detener' : '🎤 Grabar'}
</button>

<p>{transcript || 'Habla para transcribir...'}</p>
```

### Servidor Express (Node.js genérico)

```typescript
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { handleVoxtralWsConnection } from 'js-voice-toolkit/sveltekit';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  handleVoxtralWsConnection(ws, {
    apiKey: process.env.MISTRAL_API_KEY!,
    language: 'es',
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/stt-realtime') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

server.listen(3000);
```

### SvelteKit: Endpoint TTS (servidor)

```typescript
// src/routes/api/tts/+server.ts
import { textToSpeech } from 'js-voice-toolkit';
import { ELEVENLABS_API_KEY } from '$env/static/private';
import { error } from '@sveltejs/kit';

export const POST = async ({ request }) => {
  const { text } = await request.json();
  if (!text?.trim()) throw error(400, 'text requerido');

  const blob = await textToSpeech(text, {
    apiKey: ELEVENLABS_API_KEY,
    voiceId: 'XB0fDUnXU5powFXDhCwa',
  });

  return new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } });
};
```

### Componente React con STT Batch

```tsx
import { useState } from 'react';
import { transcribeLive } from 'js-voice-toolkit';

export function VoiceInput({ onText }: { onText: (t: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [session, setSession] = useState<any>(null);

  const toggle = async () => {
    if (recording) {
      session?.stop();
      setSession(null);
      return;
    }
    const s = await transcribeLive({
      apiKey: import.meta.env.VITE_MISTRAL_API_KEY,
      language: 'es',
      onTranscript: (_, full) => onText(full),
      onStart: () => setRecording(true),
      onStop: () => setRecording(false),
    });
    setSession(s);
  };

  return <button onClick={toggle}>{recording ? '⏹' : '🎤'}</button>;
}
```

---

## Buenas Prácticas

### Seguridad

```typescript
// ❌ MAL — API key expuesta en el cliente
const session = await transcribeLive({ apiKey: 'sk-...' });

// ✅ BIEN — API key solo en el servidor via transcribeLiveRealtime
const session = await transcribeLiveRealtime({
  wsUrl: `ws://${location.host}/ws/stt-realtime`,
  // La API key está en el servidor configurada con createVoxtralRealtimePlugin
});
```

### Gestión del gesto de usuario

```typescript
// ⚠️ Solicitar el micrófono SIEMPRE dentro del handler del click
// para que el navegador muestre el icono inmediatamente
button.addEventListener('click', async () => {
  // transcribeLiveRealtime solicita el micrófono en su primera línea —
  // está diseñado para llamarse directamente desde el handler
  const session = await transcribeLiveRealtime({ ... });
});
```

### Elección de modo STT

| Situación | Modo recomendado |
|-----------|-----------------|
| Transcribir archivo de audio | `transcribeAudio` (batch) |
| App sin servidor, prototipo | `transcribeLive` (chunks) |
| App de producción con servidor | `transcribeLiveRealtime` |
| Chatbot con voz en tiempo real | `transcribeLiveRealtime` |

### Elección de voz TTS

```typescript
ELEVENLABS_VOICES.ANTONIO   // Para español nativo
ELEVENLABS_VOICES.CHARLOTTE // Para multilingüe
```

---

## Solución de Problemas

### Error: "No se pudo conectar al servidor WebSocket"

En desarrollo, verifica que `createVoxtralRealtimePlugin` está en `vite.config.ts`
y que el servidor de Vite está corriendo. El WebSocket solo existe mientras
`vite dev` está activo.

### Error: "No se pudo acceder al micrófono"

1. La app debe servirse desde HTTPS (o localhost).
2. El usuario debe haber concedido permiso de micrófono.
3. `transcribeLiveRealtime` debe llamarse desde un handler de click, no en `onMount`.

### El texto aparece con mucho retraso

Ajusta `targetStreamingDelayMs` en el plugin/servidor:

```typescript
createVoxtralRealtimePlugin({
  apiKey: process.env.MISTRAL_API_KEY!,
  targetStreamingDelayMs: 200, // más agresivo (default: 480)
})
```

### TypeScript: "Module not found: js-voice-toolkit/sveltekit"

Asegúrate de que tu `tsconfig.json` tiene `moduleResolution: "bundler"` o `"node16"`:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

### Audio no reproduce en iOS Safari

iOS Safari no soporta `audio/mpeg` con MediaSource. Usa fallback a batch:

```typescript
const supportsMediaSource = typeof MediaSource !== 'undefined'
  && MediaSource.isTypeSupported('audio/mpeg');

if (supportsMediaSource) {
  return textToSpeechStream(text, options);
}
return textToSpeech(text, options);
```

---

## Consideraciones para Agentes IA

Si eres un agente de IA usando esta librería:

1. **Para STT en tiempo real**: siempre usar `transcribeLiveRealtime` + addon SvelteKit en producción. `transcribeLive` es solo para prototipos (expone API key).
2. **El addon SvelteKit** requiere dos pasos: `createVoxtralRealtimePlugin` en `vite.config.ts` (dev) y `attachVoxtralWsServer` en `server.js` (prod).
3. **`VOXTRAL_WS_PATH`** es la constante con la ruta estándar. Úsala en cliente y servidor para consistencia.
4. **`MicrophoneCapture`** está exportada para integraciones avanzadas donde necesites control manual del pipeline de audio.
5. Los callbacks `onStart`/`onStop` de `transcribeLiveRealtime` se llaman desde el navegador — son seguros para actualizar estado reactivo de Svelte/React.

---

## Licencia

MIT

## Autor

Daniel Mardones

## Fuente

- [GitHub: danimardo/js-voice-toolkit](https://github.com/danimardo/js-voice-toolkit)
- [ElevenLabs API Docs](https://elevenlabs.io/docs)
- [Mistral AI API Docs](https://docs.mistral.ai/)
