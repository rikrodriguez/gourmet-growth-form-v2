/** Test supervisor + static page; API restarts use a different PID and Pool. */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { durableProposalFixture } from '../office/external-proposal-durable-fixtures';
let fixture: Awaited<ReturnType<typeof durableProposalFixture>>;
const dashboard = process.env.PROPOSAL_DASHBOARD_FIXTURE === '1';
let fixtures: Awaited<ReturnType<typeof durableProposalFixture>>[] = [];
let child: ChildProcess | undefined;
async function stopChild() {
 if (!child) return;
 const stopping = child; child = undefined;
 if (stopping.exitCode !== null) return { code: stopping.exitCode, signal: stopping.signalCode };
 const exited = once(stopping, 'exit'); stopping.kill('SIGTERM');
 const timer = setTimeout(() => stopping.kill('SIGKILL'), 8000);
 try { const [code, signal] = await exited; return { code, signal }; } finally { clearTimeout(timer); }
}
async function startChild() {
 const config = { target: fixture.target, at: fixture.at, accessSchema: fixture.accessSchema, quoteSchema: fixture.quoteSchema, bridgeSchema: fixture.bridgeSchema, proposalSchema: fixture.proposalSchema, dashboard };
 child = fork('tests/external-proposal-durable-browser/api-server.ts', [JSON.stringify(config)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
 const current = child;
 await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { current.kill('SIGTERM'); reject(new Error('Fixture API startup timeout')); }, 20000);
  current.once('message', message => { clearTimeout(timer); if ((message as any).ready) resolve(); else reject(new Error('Invalid startup')); });
  current.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture API exited during startup')); });
 });
 return current.pid!;
}
async function reset() {
 await stopChild(); for (const prior of fixtures) await prior.close(); fixtures = [];
 fixture = await durableProposalFixture(); fixtures.push(fixture);
 await fixture.stop(); // Preserve schemas. The child must read SQL, not this Pool.
 if (dashboard) { const second = await durableProposalFixture(1); fixtures.push(second); await second.stop(); }
 return startChild();
}
try { await reset(); } catch (error) { await stopChild(); for (const prior of fixtures) await prior.close(); throw error; }
const inheritedTerm = new Set(process.listeners('SIGTERM')), inheritedInt = new Set(process.listeners('SIGINT'));
const vite = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 4194, strictPort: true,
 proxy: { '/api/office/test-proposals': { target: 'http://127.0.0.1:4195', changeOrigin: false }, '/__durable-quote': { target: 'http://127.0.0.1:4195', changeOrigin: false }, '/__durable-fixture': { target: 'http://127.0.0.1:4195', changeOrigin: false } } },
 plugins: [{ name: 'durable-fixture-supervisor', configureServer(server) {
  if (dashboard) server.middlewares.use('/office/dashboard', async (req, res) => {
   res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
   const entry = new URL(req.originalUrl ?? req.url ?? '/', 'http://127.0.0.1:4194').searchParams.get('plain') === '1' ? 'office/index.html' : 'tests/external-proposal-dashboard-browser/index.html';
   res.end(await server.transformIndexHtml('/office/dashboard', await readFile(entry, 'utf8')));
  });
  server.middlewares.use('/__durable-control', async (req, res) => {
   res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
   try {
    if (req.method !== 'POST' || req.headers.host !== '127.0.0.1:4194' || req.headers.origin !== undefined && req.headers.origin !== 'http://127.0.0.1:4194') throw new Error('Local fixture only');
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error('Too large'); }
    const { action } = JSON.parse(body);
    if (action === 'reset') { const pid = await reset(); res.end(JSON.stringify({ pid })); }
    else if (dashboard && action === 'lead') {
     await stopChild(); fixture = fixtures.find(item => item !== fixture)!;
     const pid = await startChild(); res.end(JSON.stringify({ pid, target: fixture.target }));
    }
    else if (action === 'restart') {
     const oldPid = child!.pid, stopped = await stopChild();
     if (stopped?.code !== 0 || stopped.signal !== null) throw new Error('API did not close its Pool cleanly');
     const pid = await startChild(); if (oldPid === pid) throw new Error('PID did not change');
     res.end(JSON.stringify({ oldPid, pid, oldExitCode: stopped.code, poolClosed: true }));
    }
    else throw new Error('Unknown action');
   } catch { res.statusCode = 503; res.end(JSON.stringify({ error: 'FIXTURE_REJECTED' })); }
  });
 } }] });
await vite.listen();
// Own the shutdown order: a Vite signal handler must not exit the supervisor
// before the API's Pool closes and fixture cleanup finishes.
for (const listener of process.listeners('SIGTERM')) if (!inheritedTerm.has(listener)) process.removeListener('SIGTERM', listener);
for (const listener of process.listeners('SIGINT')) if (!inheritedInt.has(listener)) process.removeListener('SIGINT', listener);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await stopChild(); await vite.close(); for (const prior of fixtures) await prior.close(); process.exit(0); }
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
