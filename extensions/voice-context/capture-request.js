/** Bound one authorized Chrome API wait. Cancellation discards late results;
 * it cannot undo a read that Chrome has already started. No automatic retry. */
export function waitForCaptureStep(start, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof start !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('La configuración de espera de captura no es válida.'));
      return;
    }
    let settled = false;
    let timer;
    const finish = (succeeded, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (succeeded) resolve(value);
      else reject(value);
    };
    const cancel = () => finish(false, new Error('Captura cancelada.'));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(false, new Error('La captura tardó demasiado. Vuelve a intentarlo o usa el texto manual.')), timeoutMs);
    try {
      // Always attach both handlers, even if cancellation happens during start.
      // Chrome can settle later; its late rejection must not become unhandled.
      Promise.resolve(start()).then(value => finish(true, value), error => finish(false, error));
    } catch (error) {
      finish(false, error);
    }
  });
}
