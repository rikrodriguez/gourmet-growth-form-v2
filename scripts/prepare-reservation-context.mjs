import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReservationBrief, manualCapture } from '../src/context/reservation-brief.mjs';

export async function main(args) {
  const options = {};
  const flags = new Set(['--confirm-authorized', '--confirm-reviewed']);
  const paths = new Set(['--capture', '--text', '--confirmed']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(options, key)) throw new Error(`Opción repetida: ${key}.`);
    if (flags.has(key)) options[key] = true;
    else if (paths.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`Opción desconocida o sin valor: ${key}.`);
  }
  if (Boolean(options['--capture']) === Boolean(options['--text'])) {
    throw new Error('Usa --capture captura.json o --text conversacion.txt. No se envía contenido a ningún servicio.');
  }
  const now = new Date().toISOString();
  const capture = options['--capture']
    ? JSON.parse(await readFile(options['--capture'], 'utf8'))
    : manualCapture(await readFile(options['--text'], 'utf8'), options['--confirm-authorized'], now);
  const confirmed = options['--confirmed'] ? JSON.parse(await readFile(options['--confirmed'], 'utf8')) : {};
  return buildReservationBrief(capture, confirmed, options['--confirm-reviewed'] ? now : null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`No se preparó el borrador: ${error.message}\n`);
    process.exitCode = 1;
  }
}
