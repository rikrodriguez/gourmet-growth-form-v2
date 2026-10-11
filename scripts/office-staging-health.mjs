import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import http from 'node:http';

function requestLoopbackHealth(target, options) {
  return new Promise((resolve, reject) => {
    // Node 24 fetch replaces an explicit Host with the loopback destination.
    // http.request preserves it and never follows a redirect.
    const request = http.request(target, { method: options.method, headers: options.headers, signal: options.signal }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        json: async () => JSON.parse(body),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

// This probe only connects to its own container. It never uses the public
// origin as a request destination and never prints credential-bearing values.
export async function checkStagingHealth({ env = process.env, fetchImpl = requestLoopbackHealth } = {}) {
  const { OFFICE_STAGING_ORIGIN: value, OFFICE_STAGING_USERNAME: username, OFFICE_STAGING_PASSWORD: password } = env;
  let origin;
  try { origin = new URL(value); } catch { throw new Error('Staging health configuration is invalid.'); }
  // WHATWG URL keeps brackets around IPv6 hosts; isIP needs the bare address.
  const hostname = origin.hostname.startsWith('[') ? origin.hostname.slice(1, -1) : origin.hostname;
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || value !== origin.origin || hostname === 'localhost' || isIP(hostname) || (origin.port && origin.port !== '443') || !username || !/^[A-Za-z0-9._-]{3,64}$/.test(username) || !password || password.length < 24 || password.length > 256 || !/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('Staging health configuration is invalid.');
  }
  const response = await fetchImpl('http://127.0.0.1:4180/office-api/health', {
    method: 'GET',
    headers: {
      Host: origin.host,
      'X-Forwarded-Proto': 'https',
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
    },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  if (!response.ok || body?.status !== 'ok' || body.mode !== 'demo' || body.storage !== 'postgres' || body.outboundEffects !== 0) {
    throw new Error('Staging health check failed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await checkStagingHealth(); }
  catch {
    process.stderr.write('Gourmet Office staging health check failed.\n');
    process.exitCode = 1;
  }
}
