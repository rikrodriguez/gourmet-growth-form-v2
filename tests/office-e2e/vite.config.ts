import { defineConfig, mergeConfig, type ProxyOptions } from 'vite';
import officeConfig from '../../vite.office.config';

// The browser suite has its own ports while exercising the unchanged API
// development guards. An untrusted Origin must reach those guards unchanged.
const proxy: ProxyOptions = {
  target: 'http://127.0.0.1:4181',
  configure(server) {
    server.on('proxyReq', (request, incoming) => {
      request.setHeader('host', '127.0.0.1:4175');
      if (incoming.headers.origin === 'http://127.0.0.1:4176') {
        request.setHeader('origin', 'http://127.0.0.1:4175');
      }
    });
  },
};

export default defineConfig(mergeConfig(officeConfig, {
  server: { port: 4176, proxy: { '/office-api': proxy } },
  preview: { port: 4176, proxy: { '/office-api': proxy } },
}));
