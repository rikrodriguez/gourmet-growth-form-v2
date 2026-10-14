import React, { useEffect, useId, useReducer, useRef, useState } from 'react';
import {
  EVENT_FIXTURE, EVENT_TABS, canApproveSimulation, createEventWorkflowState, eventWorkflowReducer,
  hasCurrentApproval, isExpectedPreviewArtifact, normalizeProposalArtifact, proposalArtifactIdentity, paymentScenarioView, PROPOSAL_PDF_EXTRACTED_TEXT,
  type Attestation, type DraftField, type EventWorkflowAction, type EventWorkflowState,
  type EventWorkflowTab, type PlanningTask, type ProposalArtifact,
} from './event-workflow';

export interface EventWorkspaceProps {
  initialTab?: EventWorkflowTab;
  activeTab?: EventWorkflowTab;
  onTabChange?: (tab: EventWorkflowTab) => void;
  onOpenCommunications?: () => void;
  proposalArtifact?: ProposalArtifact;
  /** Hide without unmounting so sidebar navigation preserves this transient record. */
  visible?: boolean;
}
type Dispatch = React.Dispatch<EventWorkflowAction>;
const units = (value: number) => `${new Intl.NumberFormat('es-PE').format(value)} U. DEMO`;
const unknown = 'Desconocido';

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`gew-card ${className}`}><h3>{title}</h3>{children}</section>;
}
function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' | 'danger' | 'success' }) {
  return <div className={`gew-notice gew-notice-${tone}`}>{children}</div>;
}
function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return <dl className="gew-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function Button({ children, onClick, disabled = false, primary = false }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean }) {
  return <button type="button" className={`gew-button${primary ? ' gew-button-primary' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function OriginalMessages() {
  return <div className="gew-messages">{EVENT_FIXTURE.messages.map((message, index) => <article className={`gew-message${index ? ' gew-message-latest' : ''}`} key={message.id}>
    <div className="gew-message-heading"><strong>{index ? 'Cambio a 24 personas' : 'Consulta original'}</strong><span>{message.id}</span></div>
    <p className="gew-muted">{message.at} · mensaje ficticio</p><p>{message.text}</p>
  </article>)}</div>;
}
function Sources({ contextRevision }: { contextRevision: number }) {
  return <><ul className="gew-source-list">{EVENT_FIXTURE.sources.map(source => <li key={source}><span>{source}</span><span className="gew-tag">Sintética</span></li>)}</ul>
    <p className="gew-muted">Captura local de contexto r{contextRevision}. Gmail, Monday y Calendario sin conectar; no verifica fuentes externas.</p></>;
}
function BriefFacts() {
  return <Facts rows={[
    ['Comensales', '24 · brief v2'], ['Fecha', EVENT_FIXTURE.brief.date], ['Zona horaria', EVENT_FIXTURE.brief.timeZone],
    ['Estado de fecha', <span className="gew-tag gew-tag-warning">Propuesta, sin reserva</span>], ['Ciudad', 'Lima'], ['Dirección', 'Pendiente de confirmar'],
    ['Restricciones', 'Pendientes de respuesta'], ['Responsable', 'Comercial DEMO'],
  ]} />;
}
function Identity({ state }: { state: EventWorkflowState }) {
  return <Facts rows={[
    ['Cuenta', state.identity.accountId], ['Buzón', state.identity.mailbox], ['Destinatario', state.draft.to],
    ['Evento', state.identity.eventId], ['Oportunidad', state.identity.opportunityId], ['Contacto', state.identity.leadId], ['Hilo', `${state.identity.threadId}:r2`],
  ]} />;
}
function Consultation({ state, go }: { state: EventWorkflowState; go: (tab: EventWorkflowTab) => void }) {
  return <div className="gew-columns"><div><Card title="Conversación original"><Identity state={state} /><OriginalMessages /></Card><Card title="Fuentes del caso"><Sources contextRevision={state.contextRevision} /></Card></div>
    <div><Card title="Brief del evento · v2"><BriefFacts /></Card><Notice tone="warning"><strong>Lugar y restricciones pendientes</strong><p>No hay disponibilidad, menú definitivo ni reserva confirmados.</p></Notice>
      <Card title="Siguiente paso"><p>El cambio de 20 a 24 personas actualiza el mismo evento y deja la propuesta v1 obsoleta.</p><div className="gew-actions"><Button primary onClick={() => go('cotizacion')}>Ver cotización v2</Button><Button onClick={() => go('brief')}>Abrir brief</Button></div></Card></div>
  </div>;
}
function Brief({ state, go }: { state: EventWorkflowState; go: (tab: EventWorkflowTab) => void }) {
  return <div className="gew-columns"><Card title="Brief compartido · BRIEF-042:r2"><BriefFacts /><div className="gew-divider" /><Identity state={state} /></Card>
    <div><Card title="De la consulta a la propuesta"><ol className="gew-timeline"><li><strong>Consulta inicial · 20 personas</strong><span>DEMO-MSG-01 conserva el texto original.</span></li><li><strong>Actualización · 24 personas</strong><span>DEMO-MSG-02 alimenta el brief v2.</span></li><li><strong>Cotización v1 · obsoleta</strong><span>No se puede aprobar ni enviar esta versión.</span></li><li><strong>Cotización v2 · vigente en DEMO</strong><span>Catálogo de laboratorio, sin tarifas reales.</span></li></ol></Card>
      <Notice><strong>Preparar no cierra una venta</strong><p>{state.humanClosed ? 'El cierre humano solo se ha representado en la simulación.' : 'El cierre humano sigue pendiente. No hay proveedor asignado.'}</p></Notice><div className="gew-actions"><Button primary onClick={() => go('cotizacion')}>Abrir cotización</Button></div></div>
  </div>;
}
function Quote({ go }: { go: (tab: EventWorkflowTab) => void }) {
  const [version, setVersion] = useState<1 | 2>(2);
  return <div className="gew-columns"><Card title="Cotización · QUOTE-042"><div className="gew-version-switch" aria-label="Versión de la cotización">
    <button type="button" aria-pressed={version === 1} onClick={() => setVersion(1)}>v1 · obsoleta</button><button type="button" aria-pressed={version === 2} onClick={() => setVersion(2)}>v2 · vigente</button></div>
    {version === 1 ? <><Notice tone="danger"><strong>20 personas · versión obsoleta</strong><p>El cambio a 24 personas invalidó esta propuesta. Su importe histórico no se ha verificado; no se recalcula con el catálogo actual.</p></Notice><Button disabled>Aprobar v1 · no disponible</Button><div className="gew-actions"><Button primary onClick={() => setVersion(2)}>Volver a v2 vigente</Button></div></> : <>
      <div className="gew-table-wrap"><table><caption>Precios de laboratorio · CAT-LAB-01</caption><thead><tr><th scope="col">Concepto</th><th scope="col">Cant.</th><th scope="col">U. DEMO</th><th scope="col">Subtotal</th></tr></thead><tbody>{EVENT_FIXTURE.quote.lines.map(line => <tr key={line.name}><th scope="row">{line.name}</th><td>{line.quantity}</td><td>{line.unitPrice}</td><td>{new Intl.NumberFormat('es-PE').format(line.quantity * line.unitPrice)}</td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={3}>Total del ejemplo</th><td>{units(3000)}</td></tr></tfoot></table></div>
      <Notice><strong>Unidades DEMO, no moneda</strong><p>Impuestos no modelados. Estos importes no son tarifas de Gourmet ni una cotización comercial válida.</p></Notice><div className="gew-actions"><Button primary onClick={() => go('revision')}>Revisar mensaje y adjunto</Button></div></>}
  </Card><div><Card title="Condiciones de laboratorio"><Facts rows={[
    ['Anticipo solicitado', units(900)], ['Saldo', 'Desconocido hasta verificar cobros'], ['Catálogo', 'CAT-LAB-01 · laboratorio'], ['Comensales', '24 · brief v2'], ['Fecha', 'Propuesta, sin reserva'], ['Lugar y restricciones', 'Pendientes'],
  ]} /></Card><Notice tone="warning"><strong>La propuesta no asigna un chef</strong><p>El cierre humano habilita sourcing; contacto, disponibilidad, aceptación y asignación se verifican por separado.</p></Notice></div></div>;
}
function Attachment({ state, artifact, dispatch }: { state: EventWorkflowState; artifact?: ProposalArtifact; dispatch: Dispatch }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = useId();
  const normalized = normalizeProposalArtifact(artifact);
  const identity = proposalArtifactIdentity(normalized);
  const inSync = identity === proposalArtifactIdentity(state.artifact);
  const pdfAvailable = !!normalized && inSync;
  const previewAvailable = pdfAvailable && isExpectedPreviewArtifact(normalized ?? undefined) && state.artifactAvailable;
  return <div className="gew-attachment"><div><strong>Adjunto de laboratorio · QUOTE-042:r2</strong><p>{EVENT_FIXTURE.attachment.fileName}</p></div>
    {pdfAvailable ? <a className="gew-button" href={normalized.href} download={normalized.fileName}>Descargar PDF completo</a> : <p className="gew-error">PDF local no disponible. La simulación de aprobación está bloqueada.</p>}
    {previewAvailable ? <><button type="button" className="gew-button" aria-expanded={previewOpen} aria-controls={previewId} onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? 'Ocultar vista previa del PDF' : 'Ver vista previa del PDF'}</button>
      <div id={previewId} hidden={!previewOpen} className="gew-pdf-preview">{previewOpen && <figure><img data-testid="event-pdf-preview" src={normalized.previewHref} alt="Página 1 de la propuesta DEMO-EVT-042-propuesta-v2.pdf" width={1117} height={1579} onError={() => dispatch({ type: 'ARTIFACT_AVAILABLE', available: false, artifactIdentity: identity })} />
        <figcaption>Página 1 de 1 · imagen renderizada del PDF adjunto de laboratorio. Verla y cerrarla conserva el borrador y no cambia de página.</figcaption></figure>}</div></>
      : <p className="gew-error" role="alert">Vista previa local no disponible o no cargada correctamente. No se puede aprobar esta simulación mientras falte.</p>}
    {pdfAvailable && <details className="gew-pdf-text"><summary>Leer el texto extraído del PDF</summary><p>Extracción literal del archivo local con pdftotext. Conserva el contenido; el PDF y su vista previa conservan la composición.</p><pre>{PROPOSAL_PDF_EXTRACTED_TEXT}</pre></details>}
    <label className="gew-check"><input type="checkbox" checked={state.draft.attachmentIncluded} onChange={event => dispatch({ type: 'SET_ATTACHMENT', included: event.target.checked })} />Incluir este adjunto en la versión revisada</label>
    <details><summary>Bytes del PDF y alcance de la verificación</summary><p>{EVENT_FIXTURE.attachment.byteLength} bytes · SHA-256 calculado sobre el PDF local al integrarlo:</p><p className="gew-hash">{EVENT_FIXTURE.attachment.sha256}</p>
      <p>Vista previa: {EVENT_FIXTURE.preview.byteLength} bytes. SHA-256 de la imagen renderizada:</p><p className="gew-hash">{EVENT_FIXTURE.preview.sha256}</p>
      <p>No verifica fuentes externas ni el contexto completo. La revisión del contexto compara su captura exacta en memoria, sin atribuirle una huella de archivo.</p></details>
  </div>;
}
const ATTESTATIONS: Array<[Attestation, string]> = [
  ['metadata', 'He revisado cuenta, buzón, evento, hilo, destinatarios y asunto exactos de esta simulación.'],
  ['content', 'He leído el texto completo y el PDF adjunto de esta versión de laboratorio.'],
  ['context', 'He revisado los mensajes originales, el brief v2, el catálogo, la propuesta y los faltantes del contexto.'],
];
function Review({ state, dispatch, artifact, onOpenCommunications }: { state: EventWorkflowState; dispatch: Dispatch; artifact?: ProposalArtifact; onOpenCommunications?: () => void }) {
  const bodyId = useId();
  const artifactInSync = proposalArtifactIdentity(artifact) === proposalArtifactIdentity(state.artifact);
  const approved = artifactInSync && hasCurrentApproval(state);
  const fields: Array<[DraftField, string]> = [['to', 'Para'], ['cc', 'CC'], ['bcc', 'CCO'], ['subject', 'Asunto']];
  return <><Notice><strong>Laboratorio de revisión exacta</strong><p>Estas acciones solo cambian este ejemplo en memoria. La revisión operativa existente sigue en <a href="/office/communications" onClick={onOpenCommunications ? event => { event.preventDefault(); onOpenCommunications(); } : undefined}>Comunicaciones</a>; este caso no se transfiere ni crea otra cola real.</p></Notice>
    <div className="gew-columns gew-review-columns"><div><Card title="Originales y cuenta"><Identity state={state} /><OriginalMessages /></Card><Card title="Contexto capturado"><Sources contextRevision={state.contextRevision} /><div className="gew-actions"><Button onClick={() => dispatch({ type: 'CONTEXT_CHANGED' })}>Simular contexto actualizado</Button></div><p className="gew-muted">Añade una revisión local de contexto e invalida cualquier aprobación previa. No consulta cuentas.</p></Card></div>
      <Card title={`Respuesta exacta · borrador r${state.draft.revision}`}><span className={`gew-tag${approved ? ' gew-tag-success' : ''}`}>{approved ? 'Aprobada en DEMO · sin envío real' : 'Pendiente de revisión'}</span>
        <div className="gew-editor-fields">{fields.map(([field, label]) => <label key={field}>{label}<input type="text" autoComplete="off" value={state.draft[field]} onChange={event => dispatch({ type: 'EDIT_DRAFT', field, value: event.target.value })} placeholder={field === 'cc' || field === 'bcc' ? 'Ninguno' : undefined} /></label>)}
          <div className="gew-editor-body"><label htmlFor={bodyId}>Texto completo que se revisaría</label><textarea id={bodyId} rows={10} value={state.draft.body} onChange={event => dispatch({ type: 'EDIT_DRAFT', field: 'body', value: event.target.value })} /></div></div>
        <Attachment state={state} artifact={artifact} dispatch={dispatch} />
        <fieldset className="gew-attestation"><legend>Revisión humana simulada · versión exacta</legend>{ATTESTATIONS.map(([field, label]) => <label key={field} className="gew-check"><input type="checkbox" checked={state.attestations[field]} onChange={event => dispatch({ type: 'ATTEST', field, checked: event.target.checked })} />{label}</label>)}</fieldset>
        <p className="gew-muted">Un cambio de texto, destinatarios, asunto, adjunto o contexto invalida la revisión y reinicia las etapas dependientes de esta simulación.</p>
        <div className="gew-actions"><Button primary disabled={!artifactInSync || !canApproveSimulation(state) || approved} onClick={() => dispatch({ type: 'APPROVE_SIMULATION' })}>Simular aprobación exacta</Button><Button disabled>Enviar correo real</Button></div>
      </Card></div>
    <Card title="Pasar al escenario posterior, de forma explícita"><p>Aprobar no envía. Cada paso siguiente representa un hecho ficticio separado; el cierre humano solo habilita la búsqueda de proveedores y la preparación del anticipo.</p>
      <div className="gew-actions"><Button disabled={!approved || state.simulatedHandoff} onClick={() => dispatch({ type: 'HANDOFF_SIMULATION' })}>Simular envío de propuesta</Button><Button disabled={!artifactInSync || !state.simulatedHandoff || state.humanClosed} onClick={() => dispatch({ type: 'CLOSE_SALE_SIMULATION' })}>Simular cierre humano</Button></div>
      <p className="gew-muted">Envío ficticio: {state.simulatedHandoff ? 'registrado localmente' : 'pendiente'} · Cierre humano ficticio: {state.humanClosed ? 'registrado localmente' : 'pendiente'}.</p>
    </Card></>;
}
const PAYMENT_STEPS = [
  ['not_prepared', 'Solicitud pendiente'], ['prepared', 'Solicitud preparada'], ['reviewed', 'Solicitud revisada'], ['link_simulated', 'Referencia creada'], ['message_reviewed', 'Mensaje revisado'], ['shared_simulated', 'Compartido en DEMO'], ['unknown', 'Cobro desconocido'],
] as const;
function Payment({ state, dispatch, go }: { state: EventWorkflowState; dispatch: Dispatch; go: (tab: EventWorkflowTab) => void }) {
  const view = paymentScenarioView(state);
  const alternate = view.scenario === 'confirmed_900';
  const currentStep = PAYMENT_STEPS.findIndex(([step]) => step === state.payment.step);
  return <><div className="gew-scenario-switch" aria-label="Caso financiero de laboratorio"><button type="button" aria-pressed={!alternate} onClick={() => dispatch({ type: 'SELECT_PAYMENT_SCENARIO', scenario: 'unknown' })}>Principal · desconocido</button><button type="button" aria-pressed={alternate} onClick={() => dispatch({ type: 'SELECT_PAYMENT_SCENARIO', scenario: 'confirmed_900' })}>Alternativo · 900 confirmados</button></div>
    <Notice tone={alternate ? 'warning' : 'neutral'}><strong>{view.label}</strong><p>{alternate ? 'Otro caso de prueba aislado. No actualiza el pago, los pasos ni el cierre del escenario principal.' : 'Generar, revisar, compartir y cobrar son hechos distintos. No hay URL de pago real ni consulta a un proveedor.'}</p></Notice>
    <div className="gew-stats"><div><span>Cotizado de laboratorio</span><strong>{units(3000)}</strong></div><div><span>Anticipo solicitado</span><strong>{units(900)}</strong></div><div><span>Cobrado</span><strong data-testid="event-collected">{view.collected === null ? unknown : units(view.collected)}</strong></div><div><span>Saldo</span><strong data-testid="event-balance">{view.balance === null ? unknown : units(view.balance)}</strong></div></div>
    {alternate ? <div className="gew-columns"><Card title="Evidencia exclusiva del caso alternativo"><Facts rows={[
      ['Caso de prueba', 'ALT-PAYMENT-900 · aislado'], ['Evento del ejemplo', state.identity.eventId], ['Pago del caso alternativo', 'Confirmado únicamente como dato de prueba'], ['Cobrado', units(900)], ['Saldo', units(2100)], ['Conciliación', 'Pendiente'],
    ]} /><p className="gew-muted">No es un recibo, un pago real ni un evento liquidado. El principal conserva PR-042:r2 y su resultado desconocido.</p><div className="gew-actions"><Button onClick={() => dispatch({ type: 'SELECT_PAYMENT_SCENARIO', scenario: 'unknown' })}>Volver al cobro principal</Button></div></Card><Notice tone="danger"><strong>Excepción humana: pago sin proveedor aceptado</strong><p>Responsable: Coordinación DEMO. Chef DEMO-03 sigue sin contacto, disponibilidad ni aceptación verificados. No puede declararse asignado.</p></Notice></div> :
      <div className="gew-columns"><Card title="Solicitud y enlace · estados separados"><ol className="gew-timeline">{PAYMENT_STEPS.slice(1).map(([step, label], index) => <li key={step} className={currentStep >= index + 1 ? 'gew-step-reached' : 'gew-step-pending'}><strong>{label}</strong><span>{currentStep >= index + 1 ? 'Representado en el escenario local' : 'Pendiente en esta simulación'}</span></li>)}</ol>
        {!state.humanClosed && <Notice tone="warning"><strong>Cierre humano simulado pendiente</strong><p>Completa revisión, envío ficticio y cierre explícito para preparar el anticipo.</p><Button onClick={() => go('revision')}>Ir a revisión exacta</Button></Notice>}
        <div className="gew-actions">
          <Button disabled={!state.humanClosed || state.payment.step !== 'not_prepared'} onClick={() => dispatch({ type: 'PREPARE_PAYMENT' })}>Preparar solicitud DEMO</Button>
          <Button disabled={state.payment.step !== 'prepared'} onClick={() => dispatch({ type: 'REVIEW_PAYMENT' })}>Simular revisión de solicitud</Button>
          <Button disabled={state.payment.step !== 'reviewed'} onClick={() => dispatch({ type: 'CREATE_PAYMENT_LINK' })}>Simular generación de enlace</Button>
          <Button disabled={state.payment.step !== 'link_simulated'} onClick={() => dispatch({ type: 'REVIEW_PAYMENT_MESSAGE' })}>Simular revisión del mensaje de cobro</Button>
          <Button disabled={state.payment.step !== 'message_reviewed'} onClick={() => dispatch({ type: 'SHARE_PAYMENT_LINK' })}>Simular compartir referencia</Button>
          <Button disabled={state.payment.step !== 'shared_simulated'} onClick={() => dispatch({ type: 'QUERY_PAYMENT_TIMEOUT' })}>Simular consulta con timeout</Button>
        </div>{state.payment.step === 'unknown' && <Notice tone="danger"><strong>TIMEOUT_DEMO · resultado incierto</strong><p>No equivale a impago ni a cero. Conservar la misma solicitud; no reenviar, volver a cobrar ni emitir recibo. Cobrado y saldo siguen desconocidos.</p></Notice>}
      </Card><div><Card title="Identidad y condiciones exactas"><Facts rows={[
        ['Evento', state.identity.eventId], ['Cuenta / buzón', `${state.identity.accountId} · ${state.identity.mailbox}`], ['Solicitud', state.payment.requestId], ['Propuesta', 'QUOTE-042:r2'], ['Destinatario', state.draft.to], ['Anticipo', units(900)], ['Referencia simulada', state.payment.linkId ?? 'No creada'], ['URL real', 'No generada'], ['Conciliación', 'Pendiente'],
      ]} /></Card><Card title="Mensaje de cobro · revisión independiente"><Facts rows={[
        ['Para', state.draft.to], ['CC / CCO', 'Ninguno'], ['Asunto', 'Anticipo de laboratorio · DEMO-EVT-042'],
      ]} /><div className="gew-message"><p>Hola, Aurora:</p><p>En este ejemplo, el anticipo solicitado es de 900 U. DEMO para DEMO-EVT-042. La referencia de laboratorio es LINK-LAB-042. No es un enlace de pago y no permite pagar.</p><p>Equipo Gourmet · Ejemplo de diseño</p></div><p className="gew-muted">Revisar la propuesta no aprueba este mensaje. La revisión de este texto ocurre en un paso separado y no autoriza mensajes reales.</p></Card></div></div>}
    <p className="gew-muted">Unidades DEMO, no moneda. Impuestos no modelados. No hay checkout, recibos ni conciliación reales.</p>
  </>;
}
function Operations({ state, dispatch, go }: { state: EventWorkflowState; dispatch: Dispatch; go: (tab: EventWorkflowTab) => void }) {
  const tasks: Array<[PlanningTask, string]> = [['menu', 'He revisado la base de menú y cantidades del ejemplo'], ['transport', 'He anotado los faltantes de transporte y montaje'], ['purchases', 'He preparado una lista local para revisión de compras']];
  return <><Notice tone="warning"><strong>Preparación incompleta</strong><p>Dirección y restricciones pendientes. Fecha propuesta, cobro principal desconocido y proveedor no aceptado. Este evento no puede marcarse listo.</p></Notice><div className="gew-columns"><div><Card title="Ficha operativa · mismo evento"><Facts rows={[
    ['Evento', state.identity.eventId], ['Cliente', 'Aurora · DEMO-L-014'], ['Brief / propuesta', 'BRIEF-042:r2 · QUOTE-042:r2'], ['Responsable', 'Coordinación DEMO'], ['Servicio', 'Cena de equipo · 24 personas'], ['Ciudad / lugar', 'Lima · dirección pendiente'], ['Cierre humano', state.humanClosed ? 'Simulado, no real' : 'Pendiente'],
  ]} /></Card><Card title="Equipo y proveedor"><div className="gew-provider-states"><span className="gew-tag">Candidato</span><span>Sin contactar</span><span>Disponibilidad desconocida</span><span>No aceptado</span><span>No asignado</span></div>
    <p><strong>Chef DEMO-03</strong> · perfil ficticio. No se ha contactado, contratado ni reservado a nadie.</p><div className="gew-actions"><Button disabled={!state.humanClosed || state.sourcingStarted} onClick={() => dispatch({ type: 'START_SOURCING_SIMULATION' })}>Iniciar búsqueda simulada</Button><Button disabled>Contactar proveedor real</Button></div>
    <p className="gew-muted">{state.sourcingStarted ? 'Búsqueda local abierta; el candidato conserva todos sus estados sin verificar.' : state.humanClosed ? 'Cierre humano simulado registrado: ahora se puede iniciar sourcing.' : 'La búsqueda se habilita únicamente tras el cierre humano simulado.'}</p></Card>
    <Card title="Logística, compras y calidad"><fieldset className="gew-attestation"><legend>Notas de preparación local</legend>{tasks.map(([task, label]) => <label key={task} className="gew-check"><input type="checkbox" checked={state.planning[task]} onChange={event => dispatch({ type: 'SET_PLANNING', task, checked: event.target.checked })} />{label}</label>)}</fieldset><p className="gew-muted">Marcar estas notas no emite pedidos, confirma entregas ni aprueba calidad. Compra, recepción y cierre operativo siguen pendientes.</p></Card></div>
    <div><Card title="Calendario del evento"><BriefFacts /><div className="gew-actions"><Button onClick={() => go('tastings')}>Coordinar tasting en Regus</Button></div></Card><Card title="Finanzas del caso principal"><Facts rows={[
      ['Solicitud', state.payment.requestId], ['Cobrado', unknown], ['Saldo', unknown], ['Conciliación', 'Pendiente'],
    ]} /><div className="gew-actions"><Button onClick={() => { dispatch({ type: 'SELECT_PAYMENT_SCENARIO', scenario: 'unknown' }); go('cobro'); }}>Ver cobro principal</Button></div></Card><Card title="Trabajar con la Oficina"><p>El chat con agentes y los mensajes externos tienen funciones distintas.</p><p className="gew-muted">La Oficina existente conserva su espacio. Al abrirla no se transfiere ni envía este ejemplo automáticamente.</p><a className="gew-button" href="/office/">Abrir Oficina</a></Card></div></div></>;
}
function Tastings({ state, dispatch }: { state: EventWorkflowState; dispatch: Dispatch }) {
  return <div className="gew-columns"><Card title="Coordinar en Regus · por ciudad y zona"><Notice><strong>Reuniones y tastings en Regus</strong><p>Proponer una ubicación de la red no acredita disponibilidad, permiso de alimentos ni reserva.</p></Notice>
    <div className="gew-editor-fields"><label>Tipo de encuentro<select value={state.meeting.type} onChange={event => dispatch({ type: 'SET_MEETING_TYPE', value: event.target.value as 'tasting' | 'meeting' })}><option value="tasting">Tasting</option><option value="meeting">Reunión</option></select></label>
      <label>Ciudad propuesta<input value={state.meeting.city} onChange={event => dispatch({ type: 'EDIT_MEETING', field: 'city', value: event.target.value })} /></label>
      <label>Zona propuesta<input value={state.meeting.zone} placeholder="Por definir" onChange={event => dispatch({ type: 'EDIT_MEETING', field: 'zone', value: event.target.value })} /></label>
      <label>Fecha propuesta del encuentro<input type="datetime-local" value={state.meeting.proposedDate} onChange={event => dispatch({ type: 'EDIT_MEETING', field: 'proposedDate', value: event.target.value })} /></label></div>
    <p className="gew-muted">La zona horaria de la sede debe verificarse. Editar la propuesta del encuentro no cambia la fecha ni la ciudad del evento.</p>
    <div className="gew-actions"><Button primary disabled={!state.meeting.city.trim() || !state.meeting.zone.trim() || state.meeting.prepared} onClick={() => dispatch({ type: 'PREPARE_MEETING' })}>Preparar ficha de coordinación</Button><Button disabled>Reservar sala real</Button><Button disabled>Enviar invitación real</Button></div>
    {state.meeting.prepared && <Notice tone="success"><strong>Ficha local preparada para revisión humana</strong><p>Regus · {state.meeting.city} · {state.meeting.zone}. No se ha consultado ni reservado ninguna sala.</p></Notice>}
  </Card><div><Card title="Verificaciones pendientes"><Facts rows={[
    ['Evento', state.identity.eventId], ['Responsable', 'Coordinación DEMO'], ['Centro y dirección', 'Por elegir y verificar'], ['Sala / aforo', 'Sin verificar'], ['Disponibilidad', 'Desconocida'], ['Alimentos externos', 'Permiso desconocido'], ['Coste completo', 'Desconocido; no es cero'], ['Condiciones / cancelación', 'Sin verificar'], ['Reserva', 'No realizada'], ['Asistencia', 'No confirmada'],
  ]} /></Card><Card title="Antes de un tasting"><ul className="gew-checklist"><li>Revisar menú, proveedor y restricciones alimentarias.</li><li>Confirmar preparación, traslado, montaje y alérgenos.</li><li>Verificar las reglas de alimentos externos del centro.</li><li>Revisar coste y condiciones antes de autorizar una reserva.</li><li>Recibir confirmación de reserva antes de aprobar invitaciones.</li></ul></Card></div></div>;
}

export function EventWorkspace({ initialTab = 'consulta', activeTab, onTabChange, onOpenCommunications, proposalArtifact, visible = true }: EventWorkspaceProps) {
  const [state, dispatch] = useReducer(eventWorkflowReducer, proposalArtifact, artifact => createEventWorkflowState(isExpectedPreviewArtifact(artifact), normalizeProposalArtifact(artifact)));
  const [localTab, setLocalTab] = useState<EventWorkflowTab>(initialTab);
  const tab = activeTab ?? localTab;
  const id = useId();
  const tabList = useRef<HTMLDivElement>(null);
  const available = isExpectedPreviewArtifact(proposalArtifact);
  const artifactIdentity = proposalArtifactIdentity(proposalArtifact);
  useEffect(() => { dispatch({ type: 'SYNC_ARTIFACT', artifact: normalizeProposalArtifact(proposalArtifact) }); }, [artifactIdentity]);
  const go = (next: EventWorkflowTab) => {
    setLocalTab(next); onTabChange?.(next);
    tabList.current?.querySelector<HTMLButtonElement>(`[data-event-tab="${next}"]`)?.focus();
  };
  const artifactInSync = artifactIdentity === proposalArtifactIdentity(state.artifact);
  const status = !artifactInSync ? 'Adjunto cambiado · revisión pendiente' : state.humanClosed ? 'Cierre humano DEMO' : state.simulatedHandoff ? 'Envío ficticio registrado' : hasCurrentApproval(state) ? 'Aprobada en DEMO · no enviada' : 'Propuesta v2 · sin aprobar';
  if (!visible) return null;
  return <section className="gourmet-event-workspace" aria-label="Ficha compartida del evento de laboratorio" data-testid="event-workspace">
    <header className="gew-case"><div><span className="gew-eyebrow">UN EVENTO · VARIAS VISTAS</span><h2>Cena de equipo · Aurora</h2><p>{state.identity.eventId} · {state.identity.opportunityId} · 24 personas</p></div><span className={`gew-tag${artifactInSync && hasCurrentApproval(state) ? ' gew-tag-success' : ''}`}>{status}</span></header>
    <div className="gew-safety"><span>DEMO local · datos ficticios · sin cuentas conectadas</span><span>No guarda cambios al salir de la sesión. Sin envíos, cobros ni reservas reales.</span></div>
    <div className="gew-tabs" ref={tabList} role="tablist" aria-label="Etapas del mismo evento">{EVENT_TABS.map((item, index) => <button type="button" role="tab" id={`${id}-tab-${item.id}`} data-event-tab={item.id} aria-controls={`${id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} key={item.id} onClick={() => go(item.id)} onKeyDown={event => {
      let next: number | undefined;
      if (event.key === 'ArrowRight') next = (index + 1) % EVENT_TABS.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + EVENT_TABS.length) % EVENT_TABS.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = EVENT_TABS.length - 1;
      if (next !== undefined) { event.preventDefault(); go(EVENT_TABS[next].id); const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]'); buttons?.[next]?.focus(); }
    }}>{item.label}</button>)}</div>
    <div className="gew-live" role="status" aria-live="polite" aria-atomic="true">{state.notice}</div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="gew-panel">
      {tab === 'consulta' && <Consultation state={state} go={go} />}
      {tab === 'brief' && <Brief state={state} go={go} />}
      {tab === 'cotizacion' && <Quote go={go} />}
      {tab === 'revision' && <Review state={state} dispatch={dispatch} artifact={proposalArtifact} onOpenCommunications={onOpenCommunications} />}
      {tab === 'cobro' && <Payment state={state} dispatch={dispatch} go={go} />}
      {tab === 'operaciones' && <Operations state={state} dispatch={dispatch} go={go} />}
      {tab === 'tastings' && <Tastings state={state} dispatch={dispatch} />}
    </div>
    <footer className="gew-footer"><p>Cuenta {state.identity.accountId} · hilo {state.identity.threadId} · un único registro sintético.</p><Button onClick={() => dispatch({ type: 'RESET', artifactAvailable: available })}>Reiniciar simulación local</Button></footer>
  </section>;
}
export default EventWorkspace;
