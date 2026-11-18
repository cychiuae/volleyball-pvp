import { defineConfig } from 'vite';
import { NET } from './src/config.js';

// `npm run dev` + `npm run server`: the dev server proxies the game's WebSocket to the Node server.
const port = Number(process.env.PORT) || NET.defaultPort;
export default defineConfig({
  server: {
    host: true, // reachable from other devices on the LAN
    proxy: { [NET.wsPath]: { target: `ws://localhost:${port}`, ws: true } },
  },
});
