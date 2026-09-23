import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, service: 'gourmet-growth-form-v2' }));

await app.register(fastifyStatic, {
  root: path.join(__dirname, 'dist'),
  prefix: '/',
});

app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not found' });
});

const port = Number(process.env.PORT || 3000);

await app.listen({
  port,
  host: '0.0.0.0',
});
