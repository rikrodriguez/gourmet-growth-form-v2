import { useEffect, useRef, useState } from 'react';
import type { QuoteScope } from '../backend/event-quote-contracts';
import type { ExternalProposalClient, ExternalProposalCommand, ExternalProposalView, ProposalTarget } from '../external-proposal-contracts';
import { verifyExternalProposalResponse } from '../external-proposal-response';

type Props = { client: ExternalProposalClient; target: ProposalTarget; identityKey: string; scope: QuoteScope };
/** Explicit manual read only. No URL, iframe, preview, editor or background provider request. */
export function ExternalProposalPanel(props: Props) {
  return <BoundPanel key={JSON.stringify([props.identityKey, props.scope, props.target])} {...props} />;
}
function BoundPanel(props: Props) {
  const { client, target } = props;
  const [view, setView] = useState<ExternalProposalView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [hashVerified, setHashVerified] = useState(false), [reviewed, setReviewed] = useState(false);
  const request = useRef<AbortController | null>(null), locked = useRef(false);
  function close() { request.current?.abort(); setView(null); setReviewed(false); setHashVerified(false); }
  useEffect(() => () => { request.current?.abort(); }, [client]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') close(); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  useEffect(() => {
    if (!view) return;
    const timer = setTimeout(close, Math.max(0, view.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [view]);
  async function run(command?: ExternalProposalCommand) {
    if (locked.current) return;
    locked.current = true; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(false); setReviewed(false); setHashVerified(false);
    try {
      const result = command ? await client.execute(target, command, controller.signal) : await client.read(target, controller.signal);
      if (controller.signal.aborted) return;
      const verified = await verifyExternalProposalResponse(result, props);
      if (controller.signal.aborted || request.current !== controller) return;
      setView(verified.view); setHashVerified(verified.contentVerified);
    } catch { if (!controller.signal.aborted) { close(); setError(true); } }
    finally { if (request.current === controller) { locked.current = false; setBusy(false); } }
  }
  const current = !busy && view && view.expiresAtMs > Date.now() ? view : null;
  const canApprove = !!current && current.canApprove && current.canWrite && current.status === 'pending_internal_review' && hashVerified && reviewed && !busy;
  const snapshot = current?.snapshot;
  const statuses = { missing: 'Sin propuesta asociada', reference_only: 'reference_only · referencia sin documento verificable', pending_internal_review: 'Pendiente de revisión interna', approved_internal_unsent: 'Aprobada internamente · sin envío', obsolete: 'Versión o contexto obsoleto · aprobación invalidada' };
  return <section className="gew-card" aria-label="Propuesta externa" data-testid="external-proposal-panel">
    <span className="gew-eyebrow">Integración de prueba · propuesta existente</span><h3>Revisar propuesta externa</h3>
    <p>Lead: {target.leadId} · Evento: {target.eventId} · Propuesta: {target.proposalId}</p>
    <p>No hay editor aquí. La aprobación es interna: no implica envío ni aceptación del cliente.</p>
    <button className="gew-button" disabled={busy} onClick={() => void run()}>Consultar propuesta externa</button>
    {busy && <p role="status">Verificando versión y acceso…</p>}
    {error && <p role="alert">No se pudo verificar el estado o el acceso. Consulta de nuevo para recuperar el resultado; no se reintenta automáticamente.</p>}
    {current && <><p role="status">{statuses[current.status]}</p>
      <button className="gew-button" disabled={busy || !current.canWrite} onClick={() => void run({ action: 'associate', key: crypto.randomUUID(), expectedRevision: current.revision })}>Asociar versión actual de prueba</button>
      {snapshot && <><p>Proveedor: {snapshot.provider} · Versión inmutable: {snapshot.sourceVersion} · Asociación: {snapshot.associationRevision}</p>
        <p>Procedencia: {snapshot.provenance.accountId} / {snapshot.provenance.boardId} / {snapshot.provenance.itemId} · {snapshot.provenance.evidenceRef}</p>
        <p>Destinatario previsto: {snapshot.intendedRecipient}</p>
        <p style={{ overflowWrap: 'anywhere' }}>SHA-256: {snapshot.sha256 ?? 'Sin contenido verificable'}</p>
        {snapshot.content !== null && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} aria-label="Contenido exacto de propuesta">{snapshot.content}</pre>}
        {snapshot.content !== null && <p>{hashVerified ? 'Hash del contenido verificado en este navegador.' : 'Contenido pendiente de verificar.'}</p>}
        <label><input type="checkbox" checked={reviewed} disabled={!hashVerified || busy || current.status !== 'pending_internal_review'} onChange={e => setReviewed(e.target.checked)} /> Revisé esta versión, su destinatario y su vínculo exactos</label>
        <div className="gew-actions"><button className="gew-button" disabled={!canApprove} onClick={() => { if (canApprove) void run({ action: 'approve', key: crypto.randomUUID(), expectedRevision: current.revision, reviewKey: snapshot.reviewKey }); }}>Aprobar documento internamente</button></div>
      </>}
    </>}
  </section>;
}
