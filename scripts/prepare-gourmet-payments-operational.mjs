import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const originals = join(repository, 'tests/payments-contract/operational-originals');
const integration = join(repository, 'integrations/gourmet-payments-v2');

function inside(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_PAYMENT_RUNTIME_SOURCE_PATH');
  }
  const target = resolve(root, name);
  if (relative(root, target).startsWith('..')) throw new Error('INVALID_PAYMENT_RUNTIME_SOURCE_PATH');
  return target;
}

async function copyExtension(source, destination, extension) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyExtension(from, to, extension);
    else if (entry.isFile() && entry.name.endsWith(extension)) {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(from), { flag: 'wx' });
    } else throw new Error('UNEXPECTED_PAYMENT_RUNTIME_EXTENSION_FILE');
  }
}

/** Materialize the verified original application plus its reviewable v2 extension.
 * This never starts PHP, migrates a database, reads an environment file or uses a
 * network. Callers must supply a new, isolated, empty destination.
 */
export async function prepareGourmetPaymentsOperationalRuntime({ destination }) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('PAYMENT_RUNTIME_REQUIRES_ABSOLUTE_DESTINATION');
  const target = resolve(destination);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length !== 0) throw new Error('PAYMENT_RUNTIME_DESTINATION_MUST_BE_EMPTY');
  const manifest = JSON.parse(await readFile(join(originals, 'SOURCES.json'), 'utf8'));
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.relative)) throw new Error('DUPLICATE_PAYMENT_RUNTIME_SOURCE');
    seen.add(file.relative);
    const bytes = await readFile(inside(originals, file.relative));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('ORIGINAL_PAYMENT_RUNTIME_HASH_MISMATCH:' + file.relative);
    }
    const to = inside(target, file.relative);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes, { flag: 'wx' });
  }
  const patch = join(integration, 'patches/operational-v2.patch');
  await run('git', ['apply', '--check', patch], { cwd: target });
  await run('git', ['apply', patch], { cwd: target });
  await copyExtension(join(integration, 'src'), join(target, 'src'), '.php');
  await copyExtension(join(integration, 'migrations'), join(target, 'migrations'), '.sql');
  // Supplemental original assets retain their own Dropbox revision/byte pins;
  // the immutable 64-file PHP baseline manifest is left unchanged.
  const assetsRoot = join(repository, 'tests/payments-contract/operational-assets');
  const assets = JSON.parse(await readFile(join(assetsRoot, 'SOURCES.json'), 'utf8'));
  for (const file of assets.files) {
    if (!['app.css', 'app.js'].includes(file.name)) throw new Error('UNEXPECTED_ORIGINAL_PAYMENT_ASSET');
    const bytes = await readFile(inside(assetsRoot, file.name));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('ORIGINAL_PAYMENT_ASSET_HASH_MISMATCH:' + file.name);
    const to = inside(target, 'public/assets/' + file.name);
    await mkdir(dirname(to), { recursive: true }); await writeFile(to, bytes, { flag: 'wx' });
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/prepare-gourmet-payments-operational.mjs /absolute/empty/directory');
  console.log(await prepareGourmetPaymentsOperationalRuntime({ destination }));
}
