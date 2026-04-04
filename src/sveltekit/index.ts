// ─── js-voice-toolkit/sveltekit ──────────────────────────────────────────────
//
// Addon de servidor para SvelteKit. Proporciona integración WebSocket con la
// API RealtimeTranscription de Mistral sin necesidad de un servidor separado.
//
// IMPORTANTE: Este módulo solo se puede importar en código de servidor Node.js.
// No importar desde rutas del navegador ni desde src/lib/ del cliente.
//
// Uso típico:
//
//   Desarrollo (vite.config.ts):
//     import { createVoxtralRealtimePlugin } from 'js-voice-toolkit/sveltekit';
//     plugins: [sveltekit(), createVoxtralRealtimePlugin({ apiKey: MISTRAL_API_KEY })]
//
//   Producción (server.js personalizado):
//     import { attachVoxtralWsServer } from 'js-voice-toolkit/sveltekit';
//     const server = createServer(handler);
//     attachVoxtralWsServer(server, { apiKey: process.env.MISTRAL_API_KEY });

import { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'http';
import { handleVoxtralWsConnection } from './ws-handler.js';
import type { VoxtralWsHandlerOptions } from './ws-handler.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Ruta WebSocket estándar usada por el cliente `transcribeLiveRealtime`.
 * Puedes usarla como `wsUrl` en el cliente:
 * `wsUrl: \`ws://\${window.location.host}\${VOXTRAL_WS_PATH}\``
 */
export const VOXTRAL_WS_PATH = '/ws/stt-realtime';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type { VoxtralWsHandlerOptions };

export interface VoxtralRealtimeServerOptions extends VoxtralWsHandlerOptions {}

// ─── Función auxiliar interna ─────────────────────────────────────────────────

function createWss(options: VoxtralRealtimeServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    handleVoxtralWsConnection(ws, options);
  });
  return wss;
}

function attachUpgradeHandler(
  httpServer: Server | import('https').Server,
  wss: WebSocketServer,
): void {
  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === VOXTRAL_WS_PATH) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });
}

// ─── createVoxtralRealtimePlugin ─────────────────────────────────────────────

/**
 * Plugin de Vite que adjunta el servidor WebSocket de Voxtral al servidor HTTP
 * de Vite durante el desarrollo. No requiere ningún proceso adicional.
 *
 * Solo activo durante `vite dev`. En producción usa `attachVoxtralWsServer`.
 *
 * @example
 * // vite.config.ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { createVoxtralRealtimePlugin } from 'js-voice-toolkit/sveltekit';
 * import { config } from 'dotenv';
 *
 * config(); // carga .env
 *
 * export default {
 *   plugins: [
 *     sveltekit(),
 *     createVoxtralRealtimePlugin({
 *       apiKey: process.env.MISTRAL_API_KEY!,
 *       language: 'es',
 *     }),
 *   ],
 * };
 */
export function createVoxtralRealtimePlugin(
  options: VoxtralRealtimeServerOptions,
): object {
  return {
    name: 'voxtral-realtime',
    configureServer(server: { httpServer: Server | null }) {
      if (!server.httpServer) return;
      const wss = createWss(options);
      attachUpgradeHandler(server.httpServer, wss);
    },
  };
}

// ─── attachVoxtralWsServer ────────────────────────────────────────────────────

/**
 * Adjunta el servidor WebSocket de Voxtral a un servidor HTTP de Node.js ya
 * existente. Diseñado para el servidor de producción personalizado de SvelteKit.
 *
 * @example
 * // server.js (raíz del proyecto SvelteKit)
 * import { createServer } from 'node:http';
 * import { handler } from './build/handler.js';
 * import { attachVoxtralWsServer } from 'js-voice-toolkit/sveltekit';
 *
 * const server = createServer(handler);
 *
 * attachVoxtralWsServer(server, {
 *   apiKey: process.env.MISTRAL_API_KEY,
 *   language: 'es',
 * });
 *
 * server.listen(3000, () => {
 *   console.log('Servidor en http://localhost:3000');
 * });
 */
export function attachVoxtralWsServer(
  httpServer: Server | import('https').Server,
  options: VoxtralRealtimeServerOptions,
): void {
  const wss = createWss(options);
  attachUpgradeHandler(httpServer, wss);
}
