import React, { useEffect, useRef, useState } from 'react';
import type { BriefInput, EventQuoteView, QuoteCommand, PaymentContractModeV2 } from '../backend/event-quote-contracts';
import { EventQuoteClientError, exactPaymentContractV2Preparation, paymentContractV2PreparationBlocked, isPaymentContractModeV2, paymentPreparationIsCurrent, exactQuoteApproval, exactQuoteReviewKey, latestBriefInput, quoteApprovalBlocked, quoteArtifactUrl, verifyQuoteArtifact,
  type EventQuoteClient, type EventQuoteStatusResponse } from '../event-quote-client';

export interface PersistedQuoteWorkspaceProps {
  /** Explicit composition only. Reuse event-workflow.css in the containing approved dashboard. */
  client: EventQuoteClient;
  eventId: string;
  /** Opaque non-secret identity/version from the existing session owner; null on logout. */
  identityKey: string | null;
}
const money = (cents: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'USD' }).format(cents / 100);
const labels: Record<EventQuoteView['currentQuoteStatus'], string> = {
  missing: 'Sin cotización', pending_internal_review: 'Pendiente de revisión interna', approved_internal_unsent: 'Aprobada internamente · sin envío', obsolete: 'Cotización obsoleta',
};
function Card({ title, children }: { title: string; children: React.ReactNode }) { return <section className="gew-card"><h3>{title}</h3>{children}</section>; }
function failureMessage(error: unknown): string {
  if (error instanceof EventQuoteClientError) {
    if (error.status === 401 || error.status === 403) return 'La identidad o los permisos ya no permiten esta acción. Recarga para verificar el acceso.';
    if (error.status === 409) return 'El expediente cambió. Recarga y revisa la versión vigente antes de continuar.';
    if (error.code === 'REQUEST_UNCERTAIN') return 'No se pudo confirmar el resultado. Recarga el expediente antes de intentar otra acción; no se reintentará automáticamente.';
  }
  return 'No se pudo completar la operación. Recarga para verificar el estado guardado antes de continuar.';
}
/** Never connects a provider, creates a session, sends mail or charges a payment. */
export function PersistedQuoteWorkspace(props: PersistedQuoteWorkspaceProps) {
  if (props.identityKey === null) return <div className="gourmet-event-workspace"><p role="status" className="gew-notice gew-notice-warning">Se requiere una identidad existente verificada. No envío ni cobro.</p></div>;
  return <BoundWorkspace key={JSON.stringify([props.identityKey, props.eventId])} {...props} />;
}
function BoundWorkspace({ client, eventId }: PersistedQuoteWorkspaceProps) {
  const [status, setStatus] = useState<EventQuoteStatusResponse | null>(null);
  const [view, setView] = useState<EventQuoteView | null>(null);
  const [brief, setBrief] = useState<BriefInput>(() => latestBriefInput(null));
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>('Cargando expediente');
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(true);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentContractModeV2 | ''>('');
  const request = useRef<AbortController | null>(null), locked = useRef(false);
  const quote = view?.record.quotes.at(-1), savedBrief = view?.record.briefs.at(-1);
  const dirty = JSON.stringify(brief) !== JSON.stringify(latestBriefInput(view));
  const reviewKey = view ? exactQuoteReviewKey(view) : null;
  const writable = !!status?.enabled && !!status.session.canWrite && !expired && status.session.expiresAtMs > Date.now()
    && !!status.catalog && status.catalog.validUntilMs > Date.now() && !needsReload && !busy;
  const readOnly = !!status && !expired && !status.session.canWrite && !!status.catalog;
  const approveBlocked = !writable || dirty || reviewed !== reviewKey || verified !== reviewKey || quoteApprovalBlocked(view, status);

  function clearPrivateState() {
    setStatus(null); setView(null); setBrief(latestBriefInput(null)); setQuantities({});
    setReviewed(null); setVerified(null); setPaymentMode(''); setNeedsReload(true); setExpired(true);
  }
  async function reload() {
    if (locked.current) return;
    locked.current = true; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy('Cargando expediente'); setError(null); setReviewed(null); setVerified(null); setPaymentMode(''); setNeedsReload(true);
    try {
      const nextStatus = await client.status(controller.signal);
      let nextView: EventQuoteView | null;
      try { nextView = await client.read(eventId, controller.signal); }
      catch (error) { if (error instanceof EventQuoteClientError && error.status === 404) nextView = null; else throw error; }
      if (controller.signal.aborted) return;
      setStatus(nextStatus); setView(nextView); setBrief(latestBriefInput(nextView)); setQuantities({}); setNeedsReload(false);
    } catch (error) {
      if (!controller.signal.aborted) { clearPrivateState(); setError(failureMessage(error)); }
    } finally { if (request.current === controller) { locked.current = false; setBusy(null); } }
  }
  useEffect(() => { void reload(); return () => { request.current?.abort(); locked.current = false; }; }, [client, eventId]);
  useEffect(() => {
    let active = true; setVerified(null); setReviewed(null); setPaymentMode('');
    if (quote && reviewKey) void verifyQuoteArtifact(quote).then(valid => { if (active && valid) setVerified(reviewKey); }).catch(() => {});
    return () => { active = false; };
  }, [quote, reviewKey]);
  useEffect(() => {
    if (!status) { setExpired(true); return; }
    const sessionRemaining = status.session.expiresAtMs - Date.now();
    const catalogRemaining = (status.catalog?.validUntilMs ?? 0) - Date.now();
    setExpired(Math.min(sessionRemaining, catalogRemaining) <= 0);
    const clearSession = () => {
      request.current?.abort(); locked.current = false; setBusy(null); clearPrivateState();
      setError('La sesión expiró. El expediente se ha cerrado; verifica tu identidad existente y recarga.');
    };
    if (sessionRemaining <= 0) { clearSession(); return; }
    const sessionTimer = setTimeout(clearSession, Math.min(sessionRemaining, 2_147_483_647));
    const catalogTimer = catalogRemaining > 0 ? setTimeout(() => { setExpired(true); setReviewed(null); }, Math.min(catalogRemaining, 2_147_483_647)) : undefined;
    return () => { clearTimeout(sessionTimer); clearTimeout(catalogTimer); };
  }, [status]);

  async function execute(command: QuoteCommand) {
    if (locked.current || !writable || !status) return;
    locked.current = true; const controller = new AbortController(); request.current = controller;
    setBusy('Guardando'); setError(null); setReviewed(null); setVerified(null); setPaymentMode('');
    try {
      const nextView = await client.execute(eventId, command, status.session.csrfToken, controller.signal);
      if (controller.signal.aborted) return;
      setView(nextView); setBrief(latestBriefInput(nextView));
      // Re-read authoritative catalogue and permissions. An unavailable refresh blocks further writes.
      const nextStatus = await client.status(controller.signal);
      if (!controller.signal.aborted) { setStatus(nextStatus); setNeedsReload(false); }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof EventQuoteClientError && (error.status === 401 || error.status === 403)) clearPrivateState();
        setNeedsReload(true); setError(failureMessage(error));
      }
    }
    finally { if (request.current === controller) { locked.current = false; setBusy(null); } }
  }
  function edit<K extends keyof BriefInput>(field: K, value: BriefInput[K]) { setBrief(previous => ({ ...previous, [field]: value })); setReviewed(null); setPaymentMode(''); }
  const nextKey = () => crypto.randomUUID();
  function saveBrief(event: React.FormEvent) { event.preventDefault(); if (!writable) return; void execute({ action: view ? 'brief' : 'create', key: nextKey(), expectedRevision: view?.record.revision ?? 0, brief }); }
  const selections = Object.entries(quantities).filter(([, value]) => value !== '' && Number(value) > 0).map(([itemId, value]) => ({ itemId, quantity: Number(value) }));
  const quantitiesValid = selections.length > 0 && Object.values(quantities).every(value => value === '' || Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000);
  function generate() { if (!view || !savedBrief || !status?.catalogDigest || dirty || !quantitiesValid) return; void execute({ action: 'quote', key: nextKey(), expectedRevision: view.record.revision, expectedBriefDigest: savedBrief.digest, expectedCatalogDigest: status.catalogDigest, selections }); }
  function approve() {
    if (approveBlocked || !view || !status) return;
    try { void execute(exactQuoteApproval(view, status, nextKey())); } catch (error) { setReviewed(null); setError(failureMessage(error)); }
  }

  function preparePayment() {
    if (!writable || dirty || !view || !status || verified !== reviewKey || !isPaymentContractModeV2(paymentMode) || paymentContractV2PreparationBlocked(view, status)) return;
    try { void execute(exactPaymentContractV2Preparation(view, status, nextKey(), paymentMode)); } catch (error) { setError(failureMessage(error)); }
  }

  return <div className="gourmet-event-workspace" data-testid="persisted-quote-workspace">
    <header className="gew-case"><div><span className="gew-eyebrow">Cotización guardada</span><h2>{eventId}</h2><p>Consulta manual → brief → catálogo autorizado → revisión exacta</p></div><span className="gew-tag">{view ? labels[view.currentQuoteStatus] : 'Pendiente de crear'}</span></header>
    <div className="gew-safety"><span>No envío ni cobro · aprobación exclusivamente interna</span><span>Fecha y lugar propuestos · reserva sin confirmar</span></div>
    <div className="gew-live" role="status" aria-live="polite">{busy ?? (view ? `Revisión guardada ${view.record.revision}. ${labels[view.currentQuoteStatus]}.` : status ? 'Completa la consulta manual para crear el expediente.' : 'Acceso pendiente de verificar.')}</div>
    {error && <p className="gew-notice gew-notice-danger" role="alert">{error}</p>}
    {readOnly && !busy && <p className="gew-notice">Solo lectura. Puedes revisar el expediente guardado; guardar, generar y aprobar permanecen bloqueados.</p>}
    {(!status?.enabled || expired) && !readOnly && !busy && <div className="gew-notice gew-notice-warning">Operación bloqueada. Se requiere identidad existente, permisos y catálogo vigente autorizado en el servidor. Recarga después de resolverlo.</div>}
    {status?.session.mode === 'test' && <p className="gew-notice">Ámbito de prueba aislado. Los datos y precios de prueba no autorizan una operación comercial.</p>}
    <div className="gew-actions"><button type="button" className="gew-button" onClick={() => void reload()} disabled={!!busy}>Recargar expediente</button></div>
    {status && <div className="gew-columns"><div><Card title={savedBrief ? `Brief manual · versión ${savedBrief.version}` : 'Consulta manual y brief'}>
      <p className="gew-muted">Conserva el mensaje recibido y lo que falta confirmar. No se consultan automáticamente Gmail, Monday ni calendario.</p>
      <form onSubmit={saveBrief}><fieldset disabled={!writable} className="gew-attestation"><legend>Datos del evento</legend><div className="gew-editor-fields">
        <label>Contacto<input value={brief.contactName} maxLength={160} required onChange={event => edit('contactName', event.target.value)} /></label>
        <label>Destinatario previsto<input type="email" value={brief.recipient} maxLength={254} required onChange={event => edit('recipient', event.target.value)} /></label>
        <label>Mensaje original<textarea value={brief.originalMessage} maxLength={8_000} required onChange={event => edit('originalMessage', event.target.value)} /></label>
        <label>Comensales<input type="number" min={1} max={10_000} value={brief.attendees} required onChange={event => edit('attendees', Number(event.target.value))} /></label>
        <label>Fecha propuesta<input value={brief.proposedDate} maxLength={120} required onChange={event => edit('proposedDate', event.target.value)} /></label>
        <label>Lugar propuesto<input value={brief.proposedLocation} maxLength={500} required onChange={event => edit('proposedLocation', event.target.value)} /></label>
        <label>Requisitos y pendientes<textarea value={brief.requirements} maxLength={8_000} required onChange={event => edit('requirements', event.target.value)} /></label>
      </div><div className="gew-actions"><button className="gew-button gew-button-primary" type="submit" disabled={!writable || !!view && !dirty}>{view ? 'Guardar nueva versión del brief' : 'Crear expediente'}</button></div></fieldset></form>
      {dirty && quote && <p className="gew-notice gew-notice-warning">Hay cambios sin guardar. Guarda el brief y genera una nueva cotización antes de aprobar.</p>}
    </Card>
    <Card title="Selección del catálogo del servidor">
      {status.catalog ? <><p>{status.catalog.id} · {status.catalog.version}</p><p className="gew-muted">Fuente: {status.catalog.source} · autorización: {status.catalog.approvalRef}</p>
        <p className="gew-muted">Impuesto: {status.catalog.taxBps / 100}% · anticipo solicitado: {status.catalog.depositBps / 100}% · vigencia: {new Date(status.catalog.validUntilMs).toISOString()}</p>
        <fieldset className="gew-attestation" disabled={!writable || !view || dirty}><legend>Cantidades explícitas</legend><div className="gew-editor-fields">{status.catalog.items.map(item => <label key={item.id}>{item.label} · {money(item.unitPriceCents)} / {item.unit}<input type="number" min={0} max={1000} step={1} value={quantities[item.id] ?? ''} placeholder="0" onChange={event => { setQuantities(previous => ({ ...previous, [item.id]: event.target.value })); setReviewed(null); }} /></label>)}</div></fieldset>
        <p>{status.catalog.terms}</p><div className="gew-actions"><button type="button" className="gew-button gew-button-primary" disabled={!writable || !view || dirty || !quantitiesValid} onClick={generate}>Generar versión de cotización</button></div></> : <p>Sin catálogo autorizado disponible. No se completan precios automáticamente.</p>}
    </Card></div><div><PersistedQuoteReview view={view} status={status} writable={writable} dirty={dirty} reviewed={reviewed} verified={verified} onReviewed={setReviewed} onApprove={approve} /><PersistedPaymentPreparation view={view} status={status} writable={writable} dirty={dirty} verified={verified} paymentMode={paymentMode} onPaymentModeChange={setPaymentMode} onPrepare={preparePayment} /></div></div>}
  </div>;
}


/** Stateless exact-version presenter; no initial persisted state can seed a new session. */
export function PersistedQuoteReview({ view, status, writable = false, dirty = true, reviewed = null, verified = null, onReviewed = () => {}, onApprove = () => {} }: {
  view: EventQuoteView | null; status: EventQuoteStatusResponse; writable?: boolean; dirty?: boolean;
  reviewed?: string | null; verified?: string | null; onReviewed?: (key: string | null) => void; onApprove?: () => void;
}) {
  const quote = view?.record.quotes.at(-1);
  const quotedBrief = view?.record.briefs.find(item => item.version === quote?.briefVersion);
  const reviewKey = view ? exactQuoteReviewKey(view) : null;
  const approveBlocked = !writable || dirty || reviewed !== reviewKey || verified !== reviewKey || quoteApprovalBlocked(view, status);
  return <Card title={quote ? `Revisión exacta · cotización v${quote.version}` : 'Revisión exacta'}>
      {quote && quotedBrief ? <><p className="gew-tag">{labels[view!.currentQuoteStatus]}</p><p>Destinatario previsto: <strong>{quotedBrief.recipient}</strong></p><p className="gew-muted">Brief v{quote.briefVersion} · catálogo {quote.catalog.id} / {quote.catalog.version}</p>
        <details className="gew-pdf-text"><summary>Consulta original de esta versión</summary><pre>{quotedBrief.originalMessage}</pre><p>{quotedBrief.requirements}</p></details><div className="gew-table-wrap"><table><caption>Importes guardados en USD · propuesta sin aceptación comercial</caption><thead><tr><th>Concepto</th><th>Cant.</th><th>Unitario</th><th>Subtotal</th></tr></thead><tbody>{quote.lines.map(line => <tr key={line.catalogItemId}><th scope="row">{line.label}</th><td>{line.qty}</td><td>{money(line.unitPriceCents)}</td><td>{money(line.qty * line.unitPriceCents)}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Subtotal</th><td>{money(quote.subtotalCents)}</td></tr><tr><th colSpan={3}>Impuesto</th><td>{money(quote.taxCents)}</td></tr><tr><th colSpan={3}>Total</th><td>{money(quote.totalCents)}</td></tr></tfoot></table></div>
        <p>Anticipo solicitado: {money(quote.depositCents)}. Cobrado: desconocido.</p><p>{quote.catalog.terms}</p>
        <p className="gew-muted">Huella de cotización: <span className="gew-hash">{quote.digest}</span></p>
        <p className="gew-muted">Huella del archivo: <span className="gew-hash">{quote.artifact.sha256}</span> · {quote.artifact.bytes} bytes</p>
        <details className="gew-pdf-text"><summary>Leer HTML exacto guardado, como texto seguro</summary><pre>{quote.artifact.html}</pre></details>
        <div className="gew-actions"><a className="gew-button" href={quoteArtifactUrl(view!.record.eventId, quote.version)} target="_blank" rel="noopener noreferrer">Abrir archivo exacto v{quote.version}</a></div>
        <p className="gew-muted">El archivo se abre aislado, sin scripts ni conexiones externas. Solo el servidor autorizado puede entregarlo.</p>
        <label className="gew-check"><input type="checkbox" checked={!!reviewKey && reviewed === reviewKey} disabled={!writable || dirty || verified !== reviewKey || quoteApprovalBlocked(view, status)} onChange={event => onReviewed(event.target.checked ? reviewKey : null)} />He revisado el mensaje original, brief, destinatario, importes, condiciones y archivo de esta versión exacta.</label>
        <button type="button" className="gew-button gew-button-primary" data-testid="persisted-quote-approve" disabled={approveBlocked} onClick={onApprove}>Aprobar internamente esta versión</button>
        <p className="gew-muted">Aprobar no envía, no acepta la venta, no confirma reserva ni genera un cobro.</p>
        {(view?.currentQuoteStatus === 'obsolete' || quote.catalogDigest !== status.catalogDigest) && <p className="gew-notice gew-notice-warning">La versión guardada quedó obsoleta. Genera una nueva propuesta con el brief y catálogo vigentes.</p>}
      </> : <p>Guarda el brief y selecciona conceptos del catálogo para generar el archivo y revisar sus importes exactos.</p>}
    </Card>;
}


/** Reuses the approved card layout; pending preparations never expose a payment link. */
export function PersistedPaymentPreparation({ view, status, writable = false, dirty = true, verified = null, paymentMode = '', onPaymentModeChange = () => {}, onPrepare = () => {} }: {
  view: EventQuoteView | null; status: EventQuoteStatusResponse; writable?: boolean; dirty?: boolean;
  verified?: string | null; paymentMode?: PaymentContractModeV2 | ''; onPaymentModeChange?: (mode: PaymentContractModeV2 | '') => void; onPrepare?: () => void;
}) {
  const preparations = view?.record.paymentPreparations ?? [], drafts = view?.record.paymentContractPreparationsV2 ?? [];
  const quote = view?.record.quotes.at(-1);
  const unavailable = !writable || dirty || !view || verified !== exactQuoteReviewKey(view) || paymentContractV2PreparationBlocked(view, status);
  const blocked = unavailable || !isPaymentContractModeV2(paymentMode) || paymentMode === 'fixed_49_reservation' && (!quote || quote.totalCents <= 4900);
  return <Card title="Preparación de enlace de pago">
    <p>Guarda un borrador interno ligado a la cotización aprobada y a una modalidad elegida expresamente. No crea un enlace, acuerdo de pago, cobro ni envío.</p>
    <label>Modalidad de pago<select data-testid="persisted-payment-mode" value={paymentMode} disabled={unavailable} onChange={event => onPaymentModeChange(isPaymentContractModeV2(event.target.value) ? event.target.value : '')}>
      <option value="">Selecciona una modalidad</option>
      <option value="retainer_50">50 % inicial y 50 % de saldo</option>
      <option value="full_upfront">100 % por adelantado</option>
      <option value="fixed_49_reservation">Reserva fija de USD 49 (excepción)</option>
    </select></label>
    {paymentMode === 'retainer_50' && <p className="gew-muted">Propuesta: 50 % inicial; saldo con fecha propuesta de 7 días calendario antes del evento. Requiere fecha del evento y zona horaria verificadas, condiciones y aprobación.</p>}
    {paymentMode === 'full_upfront' && <p className="gew-muted">Pago único del 100 %. Sin saldo futuro. Requiere condiciones explícitas y aprobación.</p>}
    {paymentMode === 'fixed_49_reservation' && <p className="gew-muted">Excepción de reserva fija de USD 49; saldo con fecha acordada. Requiere condiciones explícitas, calendario y aprobación.</p>}
    <button type="button" className="gew-button gew-button-primary" data-testid="persisted-payment-prepare" disabled={blocked} onClick={onPrepare}>Preparar solicitud de enlace</button>
    {!preparations.length && !drafts.length && <p className="gew-muted">Sin solicitud guardada. Requiere la aprobación interna de la versión vigente, permiso de aprobación y elegir una modalidad.</p>}
    {drafts.map(preparation => {
      const current = view!.currentQuoteStatus === 'approved_internal_unsent' && preparation.quoteDigest === quote?.digest
        && preparation.briefDigest === view!.record.briefs.at(-1)?.digest && preparation.catalogDigest === status.catalogDigest && !!quote && quote.catalog.validUntilMs > Date.now();
      return <section key={preparation.id} className="gew-notice" data-testid="persisted-payment-v2-request">
        <h4>Borrador de contrato v2 · cotización v{preparation.quoteVersion}</h4>
        <p className="gew-tag">{current ? 'Pendiente de configuración y aprobación · sin enlace' : 'Borrador obsoleto · conservar solo como historial'}</p>
        <p>Destinatario previsto: {preparation.intendedRecipient}</p>
        <p>Total cotizado: {money(preparation.totalCents)} · Anticipo cotizado: {money(preparation.depositCents)} ({preparation.depositBasis.basisPoints / 100} %) · resto cotizado: {money(preparation.remainingCents)}. Cobrado: desconocido.</p>
        <p>{preparation.terms}</p>
        {preparation.paymentMode === 'full_upfront' ? <p><strong>100 % por adelantado</strong> · Pago único: {money(preparation.initialPaymentCents)}. Sin saldo futuro.</p>
          : preparation.paymentMode === 'retainer_50' ? <><p><strong>50 % inicial y 50 % de saldo</strong> · Inicial: {money(preparation.initialPaymentCents)} · saldo: {money(preparation.paymentBalanceCents)}.</p><p>Fecha propuesta: 7 días calendario antes del evento. El calendario requiere fecha del evento y zona horaria verificadas y aprobación.</p></>
            : <><p><strong>Reserva fija de USD 49 (excepción)</strong> · Inicial: {money(preparation.initialPaymentCents)} · saldo: {money(preparation.paymentBalanceCents)}.</p><p>El saldo requiere una fecha acordada y un calendario aprobado.</p></>}
        {!preparation.quotedDepositMatchesMode && <p className="gew-notice gew-notice-warning">El importe inicial o la base de cálculo de la modalidad elegida difieren del anticipo cotizado. El anticipo y las condiciones originales se conservan; falta resolver y aprobar esa diferencia.</p>}
        <ul><li>Proveedor desactivado y receptor del contrato v2 no disponible. Ninguna solicitud se ha enviado.</li>
          <li>Falta vincular el lead canónico autorizado.</li>
          <li>Falta la expiración aprobada del eventual enlace.</li>
          {preparation.paymentMode !== 'full_upfront' && <li>Faltan calendario de pago y zona horaria aprobados. La fecha propuesta del evento no aprueba ese calendario.</li>}
          <li>Faltan las condiciones explícitas del contrato v2 y su aprobación autorizada. La aprobación interna de la cotización no autoriza este contrato.</li></ul>
        <p className="gew-muted">Solicitud: <span className="gew-hash">{preparation.id}</span></p>
        <p className="gew-muted">Huella: <span className="gew-hash">{preparation.digest}</span></p>
      </section>;
    })}
    {preparations.map(preparation => <section key={preparation.id} className="gew-notice" data-testid="persisted-payment-request">
      <h4>Legado · solicitud interna · cotización v{preparation.quoteVersion}</h4>
      <p className="gew-tag">{paymentPreparationIsCurrent(preparation, view!, Date.now(), status.catalogDigest) ? 'Pendiente de revisión del proveedor · sin enlace' : 'Solicitud obsoleta · conservar solo como historial'}</p>
      <p>Destinatario previsto: {preparation.intendedRecipient}</p>
      <p>Total cotizado: {money(preparation.totalCents)} · anticipo cotizado: {money(preparation.depositCents)} · resto cotizado: {money(preparation.remainingCents)}. Cobrado: desconocido.</p>
      <p>{preparation.terms}</p>
      <p className="gew-muted">Historial legado conservado. Este registro no se convierte en un contrato v2.</p>
      <ul><li>Proveedor desactivado. Ninguna solicitud se ha enviado.</li>
        <li>El contrato legado exige una reserva de USD 49 y un saldo futuro; su compatibilidad con estas condiciones está pendiente. No se sustituye el anticipo cotizado. El anticipo sigue siendo porcentual aunque coincida con USD 49.</li>
        <li>La aprobación interna no autoriza el acuerdo original de Gourmet Payments.</li>
        <li>Falta vincular el lead canónico autorizado.</li>
        <li>Faltan calendario de pago, zona horaria y expiración aprobados. La fecha propuesta del evento no aprueba ese calendario, zona horaria ni expiración.</li></ul>
      <p className="gew-muted">Solicitud: <span className="gew-hash">{preparation.id}</span></p>
      <p className="gew-muted">Huella: <span className="gew-hash">{preparation.digest}</span></p>
    </section>)}
  </Card>;
}
