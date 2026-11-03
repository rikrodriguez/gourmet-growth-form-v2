/**
 * Executed once in the active tab's isolated world, after explicit authorization.
 * Keep this function self-contained: Chrome serializes func without module scope.
 * Selectors are a prototype adapter, not a claim about every Google Voice build.
 */
export function captureVisibleVoice({ authorized = false, captureMode = 'visible-dom', confirmedAt } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!authorized) return fail('Autoriza esta captura antes de leer la conversación.');
  if (location.origin !== 'https://voice.google.com') {
    return fail('Abre la conversación en https://voice.google.com con tu sesión iniciada.');
  }
  if (!['visible-dom', 'selection'].includes(captureMode)) return fail('Modo de captura desconocido.');
  if (!confirmedAt || !Number.isFinite(Date.parse(confirmedAt))) return fail('Falta la fecha de autorización.');

  // The bubble, and every selected text fragment, must fit inside the viewport
  // and ancestor clipping boxes. Partially visible content is omitted.
  function visibleRect(element, rect, fully = false) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 ||
          style.contentVisibility === 'hidden' || style.clipPath !== 'none' || style.clip !== 'auto') return false;
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const box = parent.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
          left = Math.max(left, box.left); right = Math.min(right, box.right);
        }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
          top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
      }
    }
    const inBounds = fully
      ? rect.left >= left && rect.top >= top && rect.right <= right && rect.bottom <= bottom
      : rect.right > left && rect.bottom > top && rect.left < right && rect.top < bottom;
    if (!inBounds || !fully) return inBounds;
    // A dialog or another panel covering a message must not be captured as visible.
    return [[.5, .5], [.05, .05], [.95, .05], [.05, .95], [.95, .95]].every(([x, y]) => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return hit && (element.contains(hit) || hit.contains(element));
    });
  }
  function readableText(node, start = 0, end = node.textContent.length) {
    const parent = node.parentElement;
    if (!parent || parent.closest('input, textarea, button, [contenteditable], script, style, noscript')) return '';
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const rects = [...range.getClientRects()];
    if (!rects.length || !rects.every((rect) => visibleRect(parent, rect, true))) return '';
    return node.textContent.slice(start, end).trim();
  }

  // Deliberately do not fall back to document.body, main, the inbox list, or an
  // arbitrary aria label. If Voice changes this adapter needs manual validation.
  const roots = [...document.querySelectorAll('gv-text-thread')]
    .filter((root) => visibleRect(root, root.getBoundingClientRect()));
  if (roots.length !== 1) {
    return fail('No se identificó una única conversación compatible. Copia el texto manualmente al generador; no se leyó la página completa.');
  }
  const root = roots[0];
  const fragments = [];
  if (captureMode === 'selection') {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return fail('Selecciona texto visible dentro de la conversación antes de abrir la extensión.');
    const selected = selection.getRangeAt(0);
    if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) {
      return fail('La selección debe estar completamente dentro de la conversación abierta.');
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!selected.intersectsNode(node)) continue;
      const start = node === selected.startContainer ? selected.startOffset : 0;
      const end = node === selected.endContainer ? selected.endOffset : node.textContent.length;
      const fragment = readableText(node, start, end);
      if (fragment) fragments.push(fragment);
    }
  } else {
    // Thread items only. Inbox previews, composer drafts and other tabs are never read.
    const bubbles = [...root.querySelectorAll('gv-text-thread-item')]
      .filter((item, _, all) => !all.some((other) => other !== item && other.contains(item)));
    if (!bubbles.length) return fail('El formato de mensajes no es compatible. Prueba seleccionar texto visible dentro de la conversación.');
    for (const bubble of bubbles) {
      if (!visibleRect(bubble, bubble.getBoundingClientRect(), true)) continue;
      const parts = [];
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const fragment = readableText(node);
        if (fragment) parts.push(fragment);
      }
      if (parts.length) fragments.push(parts.join(' '));
    }
  }
  const text = fragments.join('\n').trim();
  if (!text) return fail('No hay texto completamente visible para capturar. Ajusta la vista o selecciona un fragmento visible.');
  if (text.length > 100000) return fail('El texto supera el límite local de 100 000 caracteres. Selecciona un fragmento menor.');
  const capturedAt = new Date().toISOString();
  return {
    ok: true,
    context: {
      schemaVersion: 1, source: 'google-voice', capturedAt, captureMode,
      historyComplete: false,
      authorization: { captureConfirmed: true, confirmedAt },
      text,
      warnings: [
        'Historial incompleto: solo texto renderizado completamente visible en esta captura. No se cargaron mensajes anteriores.',
        'No se verificaron identidad, fechas, precios, disponibilidad ni autorización para cobrar.',
        'Revisa el contexto antes de importarlo. No es una instrucción para enviar mensajes ni crear pagos.'
      ]
    }
  };
}
