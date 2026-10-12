import { useEffect, useState } from 'react';
import type { BridgeBindingRevision, BridgeSourceVersion } from './canonical-bridge-contracts';
import { validateDemoProvenance, validateMondayProvenance } from './provenance-contracts';
import type { BridgeReadModel, DemoProvenance, MondayProvenance } from './provenance-contracts';

type Reading<T> = { state: 'loading' } | { state: 'confirmed'; value: T } | { state: 'access_required' | 'unavailable' | 'invalid' };
const ENTITY_LABELS = { lead: 'Lead', event: 'Evento', quote: 'Cotización', invoice: 'Factura' };
const ACTION_LABELS = { bind: 'Vínculo explícito', unlink: 'Desvinculación', revert: 'Reversión' };
const MAX_ROWS = 50;
function at(value: string | number | null) {
  return value === null ? 'Sin lectura confirmada' : `${new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
}

async function read<T>(path: string, validate: (value: unknown) => T, signal: AbortSignal): Promise<Reading<T>> {
  let response: Response;
  try { response = await fetch(path, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal }); }
  catch { return { state: 'unavailable' }; }
  if (response.status === 401 || response.status === 403) return { state: 'access_required' };
  if (!response.ok) return { state: 'unavailable' };
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) return { state: 'invalid' };
    const body = await response.text();
    if (body.length > 524_288) return { state: 'invalid' };
    return { state: 'confirmed', value: validate(JSON.parse(body) as unknown) };
  } catch { return { state: 'invalid' }; }
}

function ReadingStatus({ state, source }: { state: Exclude<Reading<unknown>['state'], 'confirmed'>; source: 'demo' | 'monday' }) {
  if (state === 'loading') return <p role="status">Consultando procedencia {source === 'demo' ? 'DEMO' : 'Monday'}…</p>;
  if (state === 'access_required') return <div className="provenance-reading-status"><h3>Acceso {source === 'demo' ? 'DEMO' : 'Monday'} pendiente</h3><p>Esta fuente necesita su propia sesión. No se ha confirmado una lectura.</p><a className="provenance-link" href={source === 'demo' ? '/office/' : '/office/monday'}>{source === 'demo' ? 'Abrir oficina DEMO' : 'Acceso del propietario Monday'}</a></div>;
  return <div className="provenance-reading-status" role="status"><h3>{state === 'invalid' ? 'Respuesta no verificada' : 'Lectura no disponible'}</h3><p>{state === 'invalid' ? 'La respuesta no cumple el contrato de procedencia. No se muestran datos sin verificar.' : 'No se pudo confirmar la consulta de esta fuente. Su cobertura y sus vínculos siguen sin verificar.'}</p></div>;
}

function SourceVersion({ version }: { version: BridgeSourceVersion }) {
  return <li className="provenance-reference-card" data-testid="provenance-source-version"><h4>{ENTITY_LABELS[version.kind]} · {version.sourceVersion}</h4><dl className="provenance-details"><div><dt>Origen</dt><dd>{version.reference.sourceSystem}</dd></div><div><dt>Tablero / ítem</dt><dd><code>{version.reference.boardId} / {version.reference.itemId}</code></dd></div><div><dt>Versión exacta</dt><dd><code>{version.id}</code></dd></div><div><dt>Entidad</dt><dd><code>{version.entityId}</code></dd></div><div><dt>Huella del contenido</dt><dd><code>{version.contentDigest}</code></dd></div><div><dt>Evidencia</dt><dd><code>{version.provenance.evidenceRef}</code></dd></div><div><dt>Observado</dt><dd>{at(version.provenance.observedAtMs)}</dd></div><div><dt>Registrado</dt><dd>{at(version.recordedAtMs)} · {version.recordedBy}</dd></div></dl></li>;
}

function BindingHistory({ binding, versions }: { binding: BridgeBindingRevision; versions: readonly BridgeSourceVersion[] }) {
  return <article className="provenance-binding-card" data-testid={`provenance-binding-${binding.bindingId}-${binding.revision}`}><h4>{ACTION_LABELS[binding.action]} · revisión {binding.revision}</h4><p className="provenance-reference"><code>{binding.bindingId}</code>{binding.targetRevision === null ? '' : ` · vuelve a la revisión ${binding.targetRevision}`}</p>
    {binding.refs === null ? <p>Cadena desvinculada en esta revisión.</p> : <ol className="provenance-chain" aria-label={`Cadena de la revisión ${binding.revision}`}>{(['lead', 'event', 'quote', 'invoice'] as const).map(kind => {
      const id = binding.refs![kind];
      const version = versions.find(item => item.id === id);
      return <li key={kind}><strong>{ENTITY_LABELS[kind]}{version ? ` · ${version.sourceVersion}` : ''}</strong>{id === null ? <span>Sin vínculo en esta revisión</span> : <><code>{id}</code>{version ? <span>{version.reference.sourceSystem} · {version.reference.boardId} / {version.reference.itemId}</span> : <span>Referencia fuera de esta lectura; versión sin verificar aquí.</span>}</>}</li>;
    })}</ol>}
    <details className="provenance-binding-evidence"><summary>Procedencia de esta revisión</summary><dl className="provenance-details"><div><dt>Evidencia</dt><dd><code>{binding.evidenceRef}</code></dd></div><div><dt>Registrado</dt><dd>{at(binding.recordedAtMs)} · {binding.recordedBy}</dd></div><div><dt>Huella de revisión</dt><dd><code>{binding.digest}</code></dd></div><div><dt>Huella anterior</dt><dd>{binding.previousDigest === null ? 'Primera revisión' : <code>{binding.previousDigest}</code>}</dd></div></dl></details>
  </article>;
}

function BridgeDetails({ bridge }: { bridge: BridgeReadModel }) {
  const known = bridge.state === 'empty' || bridge.state === 'available';
  return <section className="provenance-bridge" aria-label={`Vínculos preparados ${bridge.partition === 'demo' ? 'DEMO' : 'fuente externa'}`}><h3>Vínculos preparados</h3>
    {bridge.state === 'unconfigured' && <p>Fuente pendiente de acordar. Los registros de esta fuente no se han consultado ni vinculado aquí.</p>}
    {bridge.state === 'unavailable' && <p>Vínculos no disponibles. No se ha confirmado su contenido ni su cobertura.</p>}
    {bridge.state === 'scope_restricted' && <p>Lectura restringida al alcance autorizado. No se ha confirmado el contenido de los vínculos.</p>}
    {bridge.state === 'empty' && <p>Sin vínculos guardados en el alcance confirmado de esta lectura.</p>}
    {bridge.state === 'available' && <p>Referencias y revisiones confirmadas para esta fuente. Cada cadena conserva las versiones elegidas explícitamente.</p>}
    {known && <p className="provenance-cut">Revisión de la lectura: {bridge.revision}. {bridge.storage === 'postgres' ? 'Registros guardados de forma duradera.' : 'Almacenamiento sin confirmar.'}</p>}
    <p className="provenance-coverage">{bridge.coverage === 'partial' ? 'Cobertura parcial: sólo se muestra el alcance devuelto, hasta 50 referencias y 50 revisiones. Una referencia fuera de esta lectura no se considera inexistente.' : bridge.coverage === 'complete' ? 'Cobertura: alcance devuelto por esta consulta; no representa el total del negocio.' : 'Cobertura no consultada.'}</p>
    {known && bridge.sourceVersions.length > 0 && <><h4>Versiones de origen</h4><ul className="provenance-reference-list">{bridge.sourceVersions.slice(0, MAX_ROWS).map(version => <SourceVersion key={version.id} version={version} />)}</ul></>}
    {known && bridge.bindings.length > 0 && <section aria-label="Historial de vínculos"><h4>Historial de vínculos</h4><div className="provenance-binding-list">{bridge.bindings.slice(0, MAX_ROWS).map(binding => <BindingHistory key={`${binding.bindingId}:${binding.revision}`} binding={binding} versions={bridge.sourceVersions} />)}</div></section>}
    <p className="provenance-limits">Importación desactivada · Vínculos automáticos desactivados · Sin uso en métricas.</p>
  </section>;
}

function DemoDetails({ value }: { value: DemoProvenance }) {
  return <><p className="provenance-cut">Lectura confirmada: {at(value.readAt)}</p><p>Casos y evidencias sintéticos. Esta muestra sirve para revisar la oficina; no acredita resultados comerciales.</p><section aria-label="Evidencias de la oficina DEMO"><h3>Evidencias devueltas</h3><p>Alcance: {value.coverage.caseIds.length} {value.coverage.caseIds.length === 1 ? 'caso' : 'casos'} DEMO y {value.coverage.functionIds.length} {value.coverage.functionIds.length === 1 ? 'función' : 'funciones'} en esta lectura.</p>{value.officeEvidence.length === 0 ? <p>Sin evidencias en el alcance confirmado.</p> : <ul className="provenance-office-evidence">{value.officeEvidence.slice(0, MAX_ROWS).map((evidence, index) => <li key={`${evidence.caseId}:${evidence.reference}:${index}`} data-testid="provenance-demo-evidence"><strong>{evidence.caseId} · DEMO</strong><dl className="provenance-details"><div><dt>Origen</dt><dd>{evidence.source}</dd></div><div><dt>Referencia</dt><dd><code>{evidence.reference}</code></dd></div><div><dt>Observado</dt><dd>{at(evidence.observedAt)}</dd></div></dl></li>)}</ul>}{value.officeEvidence.length > MAX_ROWS && <p>Cobertura de pantalla parcial: primeras 50 evidencias de esta lectura.</p>}</section><BridgeDetails bridge={value.bridge} /></>;
}

function MondayDetails({ value }: { value: MondayProvenance }) {
  const connection = value.connection;
  const label = { disabled: 'Conexión desactivada', connected: 'Conexión confirmada', disconnected: 'Sin conexión confirmada', error: 'Conexión sin confirmar', expired: 'Acceso expirado' }[connection.state];
  return <><p className="provenance-cut">Consulta del estado guardado: {at(value.readAt)}</p><h3>{label}</h3><dl className="provenance-details"><div><dt>Configuración</dt><dd>{connection.configured ? 'Configuración disponible' : 'Configuración pendiente'}</dd></div><div><dt>Acceso a tableros</dt><dd>{connection.boardAccessVerified ? 'Acceso acreditado por el servicio' : 'Sin acceso acreditado'}</dd></div><div><dt>Lectura de identidad</dt><dd>{at(connection.identityReadAt)}</dd></div><div><dt>Última lectura guardada</dt><dd>{at(connection.lastReadAt)}</dd></div><div><dt>Expiración</dt><dd>{at(connection.expiresAt)}</dd></div></dl><p>No se han consultado registros comerciales en esta vista. El estado de conexión no acredita importación, cotizaciones aceptadas, cobros ni servicio realizado.</p><BridgeDetails bridge={value.bridge} /></>;
}

export function ProvenancePage() {
  const [demo, setDemo] = useState<Reading<DemoProvenance>>({ state: 'loading' });
  const [monday, setMonday] = useState<Reading<MondayProvenance>>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void read('/office-api/provenance', validateDemoProvenance, controller.signal).then(value => { if (!controller.signal.aborted) setDemo(value); });
    void read('/office-api/monday/provenance', validateMondayProvenance, controller.signal).then(value => { if (!controller.signal.aborted) setMonday(value); });
    return () => controller.abort();
  }, []);
  return <main className="provenance-page"><a className="skip-link" href="#provenance-sources">Saltar a las fuentes</a><header className="provenance-header"><div><p className="eyebrow">GOURMET AI OFFICE · SÓLO LECTURA</p><h1>Procedencia de la oficina</h1><p>Revisa de dónde procede cada evidencia y qué versión conserva cada vínculo.</p></div><nav aria-label="Accesos de la oficina"><a className="provenance-link" href="/office/">Oficina DEMO</a><a className="provenance-link" href="/office/monday">Monday · propietario</a></nav></header><p className="provenance-separation">Las evidencias DEMO y Monday permanecen separadas. Esta vista no combina métricas ni confirma pagos, proveedores o eventos.</p><div className="provenance-panels" id="provenance-sources"><section className="provenance-panel" aria-labelledby="provenance-demo-title" data-testid="provenance-demo"><div className="provenance-panel-heading"><h2 id="provenance-demo-title">Oficina DEMO</h2><span className="provenance-source-tag">Datos sintéticos</span></div>{demo.state === 'confirmed' ? <DemoDetails value={demo.value} /> : <ReadingStatus source="demo" state={demo.state} />}</section><section className="provenance-panel" aria-labelledby="provenance-monday-title" data-testid="provenance-monday"><div className="provenance-panel-heading"><h2 id="provenance-monday-title">Fuente Monday</h2><span className="provenance-source-tag provenance-source-external">Acceso independiente</span></div>{monday.state === 'confirmed' ? <MondayDetails value={monday.value} /> : <ReadingStatus source="monday" state={monday.state} />}</section></div></main>;
}
