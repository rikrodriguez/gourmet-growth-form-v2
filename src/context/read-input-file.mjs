import { readFile } from 'node:fs/promises';

const INPUT_LABELS = Object.freeze({
  CONTEXT: 'el contexto de la conversación',
  REVIEW: 'la revisión humana',
  MONDAY: 'la instantánea de Monday',
  CONFIRMED: 'los datos confirmados',
});

/** Never forward local paths from private-input file errors to CLI diagnostics. */
export async function readTextInput(path, kind) {
  if (!Object.hasOwn(INPUT_LABELS, kind)) throw new Error('Tipo de entrada desconocido.');
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`${kind}_READ_FAILED: no se pudo leer ${INPUT_LABELS[kind]}. Revisa la ruta y los permisos del archivo local.`);
  }
}

/** Parse errors can contain excerpts of private content, so use a fixed message. */
export async function readJsonInput(path, kind) {
  const source = await readTextInput(path, kind);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${kind}_JSON_INVALID: ${INPUT_LABELS[kind]} debe ser un archivo JSON válido. Corrige su formato localmente y vuelve a intentarlo.`);
  }
}
