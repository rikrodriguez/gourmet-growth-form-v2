import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { OfficeIcon } from './OfficeIcon';

export function OfficeDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0 && !element.closest('[hidden]'));
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  return <dialog ref={dialog} className="office-workspace-drawer" aria-labelledby="workspace-drawer-title" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header className="drawer-header"><button type="button" className="icon-button" aria-label="Volver a mi oficina" onClick={onClose}><OfficeIcon name="back" /></button><div><h2 id="workspace-drawer-title">Espacio de trabajo</h2><p>Borradores, contexto y decisiones · DEMO</p></div><button type="button" className="icon-button" aria-label="Cerrar espacio de trabajo" onClick={onClose}><OfficeIcon name="close" /></button></header>
    <div className="drawer-content">{open ? children : null}</div>
  </dialog>;
}
