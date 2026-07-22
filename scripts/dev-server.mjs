// Tiny WebSocket server for MV3 hot reload.
//
// Started alongside `vite dev` (see scripts/dev.mjs). The extension service
// worker opens a WS to ws://localhost:37173 in dev mode. When Vite emits a
// build event we broadcast 'reload' — the SW receives it and calls
// chrome.runtime.reload(), which reloads the whole extension.
//
// This module is intentionally tiny (no deps beyond `ws`) so failures in
// dev tooling never block a plain `npm run build`.

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.BW_DEV_WS_PORT ?? 37173);

export function startDevServer() {
  const wss = new WebSocketServer({ port: PORT });
  wss.on('connection', (ws) => {
    ws.send('hello');
  });
  wss.on('listening', () => {
    console.log(`[bw-takeout dev] hot-reload WS listening on :${PORT}`);
  });
  return {
    broadcast(msg) {
      for (const client of wss.clients) {
        try {
          if (client.readyState === 1) client.send(msg);
        } catch {
          /* client gone */
        }
      }
    },
    close() {
      wss.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDevServer();
}
