/**
 * Conservative suggestions from explicitly labelled lines in a partial extract.
 * A candidate (including the last one) is never confirmation of an agreement.
 * Quotes and offsets always refer to the original, unmodified input string.
 */
export function extractEvidenceCandidates(text) {
  if (typeof text !== 'string') throw new TypeError('El contexto debe ser texto.');
  const fields = Object.fromEntries([
    'customerName', 'eventDate', 'reservationSummary', 'currency', 'agreedTotal', 'depositAmount'
  ].map((key) => [key, {
    status: 'missing', candidates: [], observations: [], latestObservation: null, hasUnresolvedUpdate: false
  }]));
  const placeholders = /^(?:pendiente|por confirmar|sin confirmar|no confirmado|no confirmada|unknown|unconfirmed|tbd|n\/?a|[-?]+)$/i;

  const amountValue = (raw) => {
    // No grouping separators, signs, percentages, scientific notation or
    // arithmetic. A dollar symbol is accepted only alongside literal USD.
    const match = /^(?:USD\s+\$?\s*([0-9]+(?:\.[0-9]{1,2})?)|\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\s+USD)$/i.exec(raw);
    if (!match) return null;
    const [whole, fraction = ''] = (match[1] || match[2]).split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
  };
  const validDate = (raw) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
  };
  const observe = (field, value, quote, start) => {
    const observation = { value, quote, start, end: start + quote.length };
    fields[field].observations.push(observation);
    if (value !== null) fields[field].candidates.push({ ...observation, latestInCapture: false });
  };
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const quote = line[0];
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(quote);
    if (!match) continue;
    const label = match[1].trim().toLowerCase();
    const raw = match[2].trim();
    const unresolved = !raw || placeholders.test(raw);
    if (['nombre del cliente', 'customer name'].includes(label)) {
      observe('customerName', unresolved ? null : raw, quote, line.index);
    } else if (['evento', 'servicio', 'event'].includes(label)) {
      observe('reservationSummary', unresolved ? null : raw, quote, line.index);
    } else if (['fecha del evento', 'fecha', 'event date', 'date'].includes(label)) {
      observe('eventDate', validDate(raw) ? raw : null, quote, line.index);
    } else if (['moneda', 'currency'].includes(label)) {
      observe('currency', /^USD$/i.test(raw) ? 'USD' : null, quote, line.index);
    } else if (['total acordado', 'agreed total'].includes(label)) {
      const value = amountValue(raw);
      observe('agreedTotal', value, quote, line.index);
      if (value !== null) observe('currency', 'USD', quote, line.index);
    } else if (['depósito', 'deposito', 'anticipo', 'deposit amount', 'deposit'].includes(label)) {
      const value = amountValue(raw);
      observe('depositAmount', value, quote, line.index);
      if (value !== null) observe('currency', 'USD', quote, line.index);
    }
  }
  for (const field of Object.values(fields)) {
    field.latestObservation = field.observations.at(-1) || null;
    field.hasUnresolvedUpdate = field.latestObservation !== null && field.latestObservation.value === null;
    if (!field.candidates.length) continue;
    if (!field.hasUnresolvedUpdate) field.candidates[field.candidates.length - 1].latestInCapture = true;
    field.status = field.hasUnresolvedUpdate || new Set(field.candidates.map(({ value }) => value)).size > 1 ? 'conflict' : 'candidate';
  }
  return { schemaVersion: 1, historyComplete: false, fields };
}
