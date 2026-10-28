import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { conversationDigest } from '../src/context/conversation-context.mjs';
import { inspectConversation, prepareFixtureGeneration } from '../src/context/reviewed-generation.mjs';
import { runFixtureAdapter } from '../src/context/generator-adapter.mjs';

export async function main(args) {
  const options = {};
  const accepted = new Set(['--context', '--vault-fixture', '--review', '--monday', '--adapter', '--php', '--out']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!accepted.has(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Opciones no válidas.');
    options[key] = args[++i];
  }
  if (Boolean(options['--context']) === Boolean(options['--vault-fixture'])) throw new Error('Usa --context archivo.json o --vault-fixture fixture.json.');
  const input = JSON.parse(await readFile(options['--context'] || options['--vault-fixture'], 'utf8'));
  const settings = {
    monday: options['--monday'] ? JSON.parse(await readFile(options['--monday'], 'utf8')) : null,
    ...(options['--vault-fixture'] ? {
      verifyVaultArtifact: value => value.fixture === true && value.verification?.method === 'fixture' &&
        value.verification.artifactSha256 === conversationDigest(value.text),
    } : {}),
  };
  if (!options['--review']) {
    if (options['--out'] || options['--adapter'] || options['--php']) throw new Error('Para generar se requiere --review.');
    return inspectConversation(input, settings);
  }
  if (!options['--out'] || !options['--adapter']) throw new Error('Configura --adapter y un directorio --out nuevo.');
  const review = JSON.parse(await readFile(options['--review'], 'utf8'));
  const prepared = prepareFixtureGeneration(input, review, settings);
  const output = runFixtureAdapter(prepared.request, {
    command: options['--php'] || 'php',
    args: ['-n', '-d', 'allow_url_fopen=0', '-d',
      'disable_functions=curl_init,curl_exec,fsockopen,pfsockopen,stream_socket_client,exec,shell_exec,passthru,system,proc_open,popen,mail',
      resolve(options['--adapter'])],
  });
  const directory = resolve(options['--out']);
  await mkdir(directory, { recursive: false });
  await writeFile(resolve(directory, 'preview.html'), output.landingHtml, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(directory, 'paypal-request.fixture.json'), `${JSON.stringify(output.paypalRequest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(directory, 'review-report.json'), `${JSON.stringify(prepared.report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { status: 'fixture-only-generated', directory, execution: output.execution, historyComplete: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
