import { captureVisibleVoice } from './capture.js';
import { extractEvidenceCandidates } from './evidence.js';

const element = (id) => document.getElementById(id);
const authorize = element('authorize');
const capture = element('capture');
const context = element('context');
const reviewed = element('reviewed');
const exportButton = element('export');
let snapshot = null;
let requestNumber = 0;
let busy = false;

function updateEvidence() {
  const labels = {
    customerName: 'Cliente', eventDate: 'Fecha del evento', reservationSummary: 'Evento / servicio',
    currency: 'Moneda', agreedTotal: 'Total acordado', depositAmount: 'Depósito'
  };
  const states = { missing: 'Falta evidencia', candidate: 'Candidato sin confirmar', conflict: 'Conflicto sin resolver' };
  const { fields } = extractEvidenceCandidates(context.value);
  const rows = Object.entries(fields).map(([name, field]) => {
    const row = document.createElement('tr');
    row.dataset.field = name;
    row.dataset.status = field.status;
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = labels[name];
    const state = document.createElement('td');
    state.textContent = states[field.status];
    const evidence = document.createElement('td');
    if (!field.candidates.length) evidence.textContent = 'Sin frase etiquetada compatible. Revisar manualmente.';
    if (field.hasUnresolvedUpdate) {
      row.dataset.unresolvedUpdate = 'true';
      const unresolved = document.createElement('div');
      unresolved.className = 'unresolved-update';
      const warning = document.createElement('strong');
      warning.textContent = 'Última observación no resuelta. Los valores anteriores no se consideran vigentes.';
      const quote = document.createElement('blockquote');
      quote.textContent = field.latestObservation.quote;
      const provenance = document.createElement('small');
      provenance.textContent = `Texto ${field.latestObservation.start}–${field.latestObservation.end} · Requiere aclaración manual.`;
      unresolved.append(warning, quote, provenance);
      evidence.append(unresolved);
    }
    for (const candidate of field.candidates) {
      const item = document.createElement('div');
      item.className = 'candidate';
      const value = document.createElement('strong');
      value.textContent = candidate.value;
      const quote = document.createElement('blockquote');
      quote.textContent = candidate.quote;
      const provenance = document.createElement('small');
      provenance.textContent = `Texto ${candidate.start}–${candidate.end}${candidate.latestInCapture ? ' · Última aparición en este extracto; no prueba el último acuerdo.' : ''}`;
      item.append(value, quote, provenance);
      evidence.append(item);
    }
    row.append(label, state, evidence);
    return row;
  });
  element('evidence-rows').replaceChildren(...rows);
}

function update() {
  capture.disabled = !authorize.checked || busy;
  exportButton.disabled = !snapshot || !authorize.checked || !reviewed.checked || !context.value.trim();
}
function clear(message = 'Captura descartada. No se ha leído otra conversación.') {
  requestNumber += 1;
  snapshot = null;
  context.value = '';
  reviewed.checked = false;
  element('preview').hidden = true;
  element('metadata').textContent = '';
  element('warnings').replaceChildren();
  element('evidence-rows').replaceChildren();
  element('status').textContent = message;
  update();
}
authorize.addEventListener('change', () => {
  if (!authorize.checked) clear('Autorización retirada. Captura descartada.');
  update();
});
element('mode').addEventListener('change', () => clear('Modo cambiado. Vuelve a capturar con tu autorización.'));
element('clear').addEventListener('click', () => clear());
reviewed.addEventListener('change', update);
context.addEventListener('input', () => { reviewed.checked = false; updateEvidence(); update(); });

capture.addEventListener('click', async () => {
  if (!authorize.checked || busy) return;
  clear('Leyendo únicamente la vista autorizada…');
  const currentRequest = requestNumber;
  const confirmedAt = new Date().toISOString();
  busy = true;
  update();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || new URL(tab.url).origin !== 'https://voice.google.com') {
      throw new Error('Abre una conversación en https://voice.google.com con tu sesión iniciada.');
    }
    if (currentRequest !== requestNumber || !authorize.checked) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureVisibleVoice,
      args: [{ authorized: true, captureMode: element('mode').value, confirmedAt }]
    });
    if (currentRequest !== requestNumber || !authorize.checked) return;
    if (results.length !== 1 || !results[0].result?.ok) {
      throw new Error(results[0]?.result?.error || 'No se pudo identificar una única vista compatible.');
    }
    snapshot = results[0].result.context;
    context.value = snapshot.text;
    updateEvidence();
    element('metadata').textContent = `Google Voice · ${snapshot.capturedAt} · ${snapshot.captureMode} · historial incompleto`;
    element('warnings').replaceChildren(...snapshot.warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    }));
    element('preview').hidden = false;
    element('status').textContent = 'Captura local preparada. Revisa el texto antes de exportar.';
  } catch (error) {
    if (currentRequest === requestNumber) clear(error.message || 'No se pudo capturar. Copia el texto manualmente.');
  } finally {
    busy = false;
    update();
  }
});

exportButton.addEventListener('click', () => {
  if (!snapshot || !authorize.checked || !reviewed.checked || !context.value.trim()) return;
  const edited = context.value.trim() !== snapshot.text;
  const exported = {
    ...snapshot,
    text: context.value.trim(),
    historyComplete: false,
    warnings: edited ? [...snapshot.warnings, 'Texto corregido o editado por el usuario después de la captura.'] : snapshot.warnings
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `voice-context-${snapshot.capturedAt.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  element('status').textContent = 'Descarga solicitada. No se envió el contexto a ningún servidor.';
});
update();
