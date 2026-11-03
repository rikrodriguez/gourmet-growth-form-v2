const FIELDS = ['customerName', 'eventDate', 'reservationSummary', 'currency', 'agreedTotal', 'depositAmount'];
const FIELD_SET = new Set(FIELDS);
const SNAPSHOT_KEYS = new Set(['source', 'fetchedAt', 'itemId', 'identityConfirmed', 'fields']);

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function realTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  // Date.parse normalizes impossible calendar dates; comparing UTC components rejects them.
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function validateFields(input, label) {
  if (!object(input)) throw new Error(`${label}: se requiere un objeto de campos.`);
  const output = {};
  for (const [field, value] of Object.entries(input)) {
    if (!FIELD_SET.has(field)) throw new Error(`${label}: campo desconocido ${field}.`);
    if (value === '') continue;
    if (typeof value !== 'string' || value !== value.trim() || value.length > 2000) {
      throw new Error(`${label}: ${field} debe ser texto explícito sin espacios externos.`);
    }
    if (field === 'eventDate' && !realDate(value)) throw new Error(`${label}: eventDate debe ser una fecha real YYYY-MM-DD.`);
    if (field === 'currency' && value !== 'USD') throw new Error(`${label}: currency debe confirmarse como USD.`);
    if (field === 'agreedTotal' || field === 'depositAmount') {
      if (!/^(?:0|[1-9]\d{0,8})\.\d{2}$/.test(value) || BigInt(value.replace('.', '')) <= 0n) {
        throw new Error(`${label}: ${field} debe ser una cantidad positiva con dos decimales.`);
      }
    }
    output[field] = value;
  }
  if (output.agreedTotal && output.depositAmount && BigInt(output.depositAmount.replace('.', '')) > BigInt(output.agreedTotal.replace('.', ''))) {
    throw new Error(`${label}: el depósito no puede superar el total.`);
  }
  return output;
}

/**
 * Compare an explicitly identified snapshot with reviewed values, without fetching
 * or changing either source. A matching snapshot is not proof of latest agreement,
 * complete conversation history, payment status or authority to create a payment.
 */
export function compareMonday(reviewedFields, snapshot = null) {
  const voice = validateFields(reviewedFields, 'Voice revisado');
  if (snapshot === null) {
    return {
      status: 'unavailable',
      fields: Object.fromEntries(FIELDS.map(field => [field, {
        status: 'unavailable', voiceValue: voice[field] ?? null, mondayValue: null,
      }])),
      provenance: null,
      warnings: ['No se proporcionó un snapshot de Monday; no se verificó ninguna reserva en Monday.'],
    };
  }
  if (!object(snapshot)) throw new Error('Monday: se requiere un snapshot válido.');
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEYS.has(key)) throw new Error(`Monday: propiedad desconocida ${key}.`);
  }
  if (snapshot.source !== 'monday' || !realTimestamp(snapshot.fetchedAt) ||
      typeof snapshot.itemId !== 'string' || !snapshot.itemId.trim() ||
      snapshot.itemId !== snapshot.itemId.trim() || snapshot.itemId.length > 128) {
    throw new Error('Monday: faltan origen, fecha UTC real o identificador del registro.');
  }
  if (snapshot.identityConfirmed !== true) {
    throw new Error('Monday: confirma explícitamente la identidad del lead y evento antes de comparar.');
  }
  const monday = validateFields(snapshot.fields, 'Monday');
  const fields = Object.fromEntries(FIELDS.map(field => {
    const voiceValue = voice[field] ?? null;
    const mondayValue = monday[field] ?? null;
    return [field, {
      status: voiceValue === null || mondayValue === null ? 'missing' : voiceValue === mondayValue ? 'match' : 'conflict',
      voiceValue, mondayValue,
    }];
  }));
  const states = Object.values(fields).map(field => field.status);
  const status = states.includes('conflict') ? 'conflict' : states.includes('missing') ? 'incomplete' : 'match';
  return {
    status,
    fields,
    provenance: { source: 'monday', fetchedAt: snapshot.fetchedAt, itemId: snapshot.itemId, identityConfirmed: true },
    warnings: [
      'El snapshot conserva su fecha de lectura; no demuestra frescura actual ni el último acuerdo de Voice.',
      'La identidad es una confirmación declarada del operador; este comparador no autentica personas.',
      ...(status === 'conflict' ? ['Hay diferencias entre Voice y Monday. Se conservan ambas fuentes para revisión explícita.'] : []),
      ...(states.includes('missing') ? ['Faltan campos en una o ambas fuentes. No se completaron automáticamente.'] : []),
    ],
  };
}
