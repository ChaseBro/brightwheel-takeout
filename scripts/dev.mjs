// Orchestrator for `npm run dev` — starts Vite in build-watch mode and the
// hot-reload WS server. On every rebuild, broadcasts 'reload' so the
// extension SW calls chrome.runtime.reload().

import { createServer, build } from 'vite';
import { startDevServer } from './dev-server.mjs';

const devServer = startDevServer();

// Use build --watch instead of the dev server: crxjs generates a proper MV3
// bundle only from `vite build`. The watcher rebuilds on file change.
const watcher = await build({
  build: { watch: {}, sourcemap: 'inline', minify: false },
  mode: 'development',
});

if (Array.isArray(watcher)) {
  for (const w of watcher) {
    if (w && typeof w.on === 'function') {
      w.on('event', (ev) => {
        if (ev.code === 'END') devServer.broadcast('reload');
      });
    }
  }
} else if (watcher && typeof watcher.on === 'function') {
  watcher.on('event', (ev) => {
    if (ev.code === 'END') devServer.broadcast('reload');
  });
}

// Silence Vite's normal http dev warning — we're not using it for the extension.
void createServer;

console.log('[bw-takeout dev] watching for changes. Load the unpacked extension from ./dist');
