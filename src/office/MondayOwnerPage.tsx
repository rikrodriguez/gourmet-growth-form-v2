import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { MondayReadItem, MondayReadResult, MondayUpdateItem } from './backend/monday-read';

type OwnerSession = { available: boolean; authenticated: false } | { available: true; authenticated: true; principal: 'ricardo'; csrfToken: string; expiresAt: string };
type OwnerLogin = { csrfToken: string; expiresAt: string; principal?: 'ricardo' };
type ConnectionState = 'disabled' | 'disconnected' | 'connected' | 'error' | 'expired';
type MondayStatus = {
  state: ConnectionState; configured: boolean; code: string | null; actorId: string | null; accountId: string | null;
  accountVerified: false; configuredAccountId: string | null; boardAccessVerified: boolean; boardAccessReadAt: string | null;
  scopes: string[]; allowedBoards: string[]; expiresAt: string | null; connectedAt: string | null;
  identityReadAt: string | null; lastReadAt: string | null; updatedAt: string | null; pending: boolean;
};
type Reading = { kind: 'board'; result: MondayReadResult<MondayReadItem> } | { kind: 'updates'; result: MondayReadResult<MondayUpdateItem> };
type Row = Record<string, unknown>;
const API = '/office-api/monday';
const SCOPES = ['boards:read', 'updates:read', 'me:read'];
const BOARD_IDS = ['18403945258', '18411103560', '18398057136', '18396813878', '18377848804'];
const OAUTH_CODES = ['disabled', 'configuration_invalid', 'owner_forbidden', 'oauth_state_invalid', 'oauth_state_expired', 'oauth_denied', 'operation_in_progress', 'code_exchange_uncertain', 'token_invalid', 'scope_mismatch', 'identity_mismatch', 'board_access_unverified', 'refresh_uncertain', 'expired', 'not_connected', 'connection_changed', 'revoke_uncertain', 'read_unavailable', 'storage_unavailable'];
const READ_CODES = ['disabled', 'invalid_request', 'forbidden_board', 'scopes_mismatch', 'expired', 'columns_unconfigured', 'incompatible', 'unauthorized', 'forbidden', 'rate_limited', 'provider_partial', 'offline', 'aborted', 'cursor_expired', 'cursor_cycle', 'page_limit', 'updates_limit'];
const STATES: ConnectionState[] = ['disabled', 'disconnected', 'connected', 'error', 'expired'];
const FIELDS = { stage: 'Etapa', event_type: 'Tipo de evento', guest_count: 'Personas', event_date: 'Fecha del evento', service_style: 'Servicio', amount: 'Importe', quote_status: 'Estado de cotización' };
const STATE_LABELS: Record<ConnectionState, string> = { disabled: 'Desactivado', disconnected: 'Desconectado', connected: 'Conectado', error: 'Error de conexión', expired: 'Conexión expirada' };
const ERROR_TEXT = {
  offline: 'No se pudo confirmar la respuesta del servicio. Vuelve a consultar el estado.',
  incompatible: 'La respuesta no cumple el contrato de Monday. No se muestran datos sin verificar.',
  unauthorized: 'La sesión del propietario no está vigente. Vuelve a acceder.',
  owner_login_failed: 'No se pudo confirmar el acceso del propietario. Vuelve a intentarlo.',
  forbidden: 'El acceso del propietario o la acción fueron rechazados.',
  unavailable: 'Monday no está disponible para esta acción. La configuración o el consentimiento siguen pendientes.',
};
class MondayPageError extends Error { constructor(readonly code: keyof typeof ERROR_TEXT) { super(ERROR_TEXT[code]); } }
function bad(): never { throw new MondayPageError('incompatible'); }
function row(value: unknown): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) bad(); return value as Row; }
function keys(value: Row, required: string[], optional: string[] = []) { if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) bad(); }
function text(value: unknown, maximum = 160): string { if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) bad(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') bad(); return value; }
function numericId(value: unknown): string { const result = text(value, 30); if (!/^[1-9][0-9]{0,29}$/.test(result)) bad(); return result; }
function date(value: unknown): string { const result = text(value, 40); if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(result) || !Number.isFinite(Date.parse(result))) bad(); return result; }
function nullableDate(value: unknown) { return value === null ? null : date(value); }
function csrf(value: unknown): string { const result = text(value, 512); if (!/^[A-Za-z0-9_-]{16,512}$/.test(result)) bad(); return result; }
function list<T>(value: unknown, parse: (item: unknown) => T, maximum: number): T[] { if (!Array.isArray(value) || value.length > maximum) bad(); return value.map(parse); }
function safeCode(value: unknown): string { const result = text(value, 96); if (!/^[a-z][a-z0-9_]{0,95}$/i.test(result)) bad(); return result; }
function login(value: unknown, authenticated = false): OwnerLogin {
  const result = row(value); keys(result, ['csrfToken', 'expiresAt', ...(authenticated ? ['principal'] : [])]);
  if (authenticated && result.principal !== 'ricardo') bad();
  return { csrfToken: csrf(result.csrfToken), expiresAt: date(result.expiresAt), ...(authenticated ? { principal: 'ricardo' } : {}) };
}
function ownerSession(value: unknown): OwnerSession {
  const result = row(value); const available = bool(result.available), authenticated = bool(result.authenticated);
  if (!authenticated) { keys(result, ['available', 'authenticated']); return { available, authenticated: false }; }
  keys(result, ['available', 'authenticated', 'principal', 'csrfToken', 'expiresAt']);
  if (!available || result.principal !== 'ricardo') bad();
  return { available: true, authenticated: true, principal: 'ricardo', csrfToken: csrf(result.csrfToken), expiresAt: date(result.expiresAt) };
}
function status(value: unknown): MondayStatus {
  const result = row(value);
  keys(result, ['state', 'configured', 'code', 'actorId', 'accountId', 'accountVerified', 'configuredAccountId', 'boardAccessVerified', 'boardAccessReadAt', 'scopes', 'allowedBoards', 'expiresAt', 'connectedAt', 'identityReadAt', 'lastReadAt', 'updatedAt', 'pending']);
  if (!STATES.includes(result.state as ConnectionState)) bad();
  if (result.code !== null && !OAUTH_CODES.includes(safeCode(result.code))) bad();
  const scopes = list(result.scopes, value => { const scope = text(value, 32); if (!SCOPES.includes(scope)) bad(); return scope; }, 3);
  const allowedBoards = list(result.allowedBoards, numericId, 5);
  if (new Set(scopes).size !== scopes.length || new Set(allowedBoards).size !== allowedBoards.length || allowedBoards.some(id => !BOARD_IDS.includes(id))) bad();
  if (result.accountId !== null || result.accountVerified !== false) bad();
  const boardAccessVerified = bool(result.boardAccessVerified);
  if (result.state === 'connected' && (result.actorId !== '78158865' || !boardAccessVerified || scopes.length !== 3 || allowedBoards.length !== 5)) bad();
  return {
    state: result.state as ConnectionState, configured: bool(result.configured), code: result.code === null ? null : safeCode(result.code),
    actorId: result.actorId === null ? null : numericId(result.actorId), accountId: null, accountVerified: false,
    configuredAccountId: result.configuredAccountId === null ? null : numericId(result.configuredAccountId), boardAccessVerified,
    boardAccessReadAt: nullableDate(result.boardAccessReadAt),
    scopes, allowedBoards, pending: bool(result.pending), expiresAt: nullableDate(result.expiresAt), connectedAt: nullableDate(result.connectedAt),
    identityReadAt: nullableDate(result.identityReadAt), lastReadAt: nullableDate(result.lastReadAt), updatedAt: nullableDate(result.updatedAt),
  };
}
function readResult(value: unknown, kind: Reading['kind'], boardId: string): Reading {
  const result = row(value); keys(result, ['status', 'boardId', 'mappingVersion', 'readAt', 'pages', 'items'], ['reason', 'retryAfterSeconds']);
  if (!['complete', 'partial', 'blocked'].includes(result.status as string) || numericId(result.boardId) !== boardId || !Number.isSafeInteger(result.pages) || Number(result.pages) < 0 || Number(result.pages) > 4) bad();
  if (result.reason !== undefined && !READ_CODES.includes(safeCode(result.reason))) bad();
  const common = { status: result.status as 'complete' | 'partial' | 'blocked', boardId: boardId as MondayReadItem['boardId'], mappingVersion: text(result.mappingVersion, 96), readAt: date(result.readAt), pages: Number(result.pages), ...(result.reason !== undefined ? { reason: safeCode(result.reason) as MondayReadResult<MondayReadItem>['reason'] } : {}) };
  if (result.retryAfterSeconds !== undefined && (!Number.isSafeInteger(result.retryAfterSeconds) || Number(result.retryAfterSeconds) < 0 || Number(result.retryAfterSeconds) > 86400)) bad();
  const items = list(result.items, value => {
    const item = row(value); keys(item, ['id', 'boardId', 'sourceUpdatedAt', 'readAt', kind === 'board' ? 'columns' : 'updates']);
    if (numericId(item.boardId) !== boardId) bad();
    const base = { id: numericId(item.id), boardId: common.boardId, sourceUpdatedAt: nullableDate(item.sourceUpdatedAt), readAt: date(item.readAt) };
    if (kind === 'updates') return { ...base, updates: list(item.updates, value => {
      const update = row(value); keys(update, ['id', 'createdAt', 'sourceUpdatedAt', 'readAt']);
      return { id: numericId(update.id), createdAt: nullableDate(update.createdAt), sourceUpdatedAt: nullableDate(update.sourceUpdatedAt), readAt: date(update.readAt) };
    }, 20) };
    return { ...base, columns: list(item.columns, value => {
      const column = row(value); keys(column, ['id', 'field', 'type', 'text', 'redacted']);
      const id = text(column.id, 96); if (!/^[A-Za-z0-9_]+$/.test(id) || !Object.hasOwn(FIELDS, String(column.field)) || !['status', 'dropdown', 'numbers', 'date'].includes(String(column.type))) bad();
      const content = column.text === null ? null : text(column.text);
      if (content && /@|https?:\/\/|www\.|(?:bearer|token|secret|password|api[_ -]?key)\s*[:=]|[<>]|[A-Za-z0-9_-]{32,}/i.test(content)) bad();
      const redacted = bool(column.redacted); if (redacted && content !== null) bad();
      return { id, field: column.field as MondayReadItem['columns'][number]['field'], type: column.type as MondayReadItem['columns'][number]['type'], text: content, redacted };
    }, 20) };
  }, 100);
  if (new Set(items.map(item => item.id)).size !== items.length) bad();
  return kind === 'board' ? { kind, result: { ...common, items: items as MondayReadItem[] } } : { kind, result: { ...common, items: items as MondayUpdateItem[] } };
}
async function request(path: string, options: { csrfToken?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal,
      headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.csrfToken ? { 'x-monday-owner-csrf': options.csrfToken } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch { throw new MondayPageError('offline'); }
  if (response.status === 403 && response.headers.get('content-type')?.includes('application/json')) {
    const failure: unknown = await response.json().catch(() => null);
    if (failure && typeof failure === 'object' && !Array.isArray(failure) && Object.keys(failure).length === 1
      && 'error' in failure && failure.error === 'MONDAY_OWNER_UNAUTHORIZED') throw new MondayPageError('unauthorized');
  }
  if (!response.ok) throw new MondayPageError(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 503 ? 'unavailable' : 'incompatible');
  if (response.status === 204) return null;
  try { if (!response.headers.get('content-type')?.includes('application/json')) bad(); return await response.json(); } catch { bad(); }
}
function authorizationUrl(value: unknown): string {
  const result = row(value); keys(result, ['authorizationUrl'], ['expiresAt']);
  if (result.expiresAt !== undefined) date(result.expiresAt);
  let url: URL; try { url = new URL(text(result.authorizationUrl, 8192)); } catch { bad(); }
  if (url.protocol !== 'https:' || url.hostname !== 'auth.monday.com' || url.pathname !== '/oauth2/authorize' || url.port || url.username || url.password || url.hash) bad();
  return url.href;
}
function at(value: string | null): string { return value ? new Date(value).toLocaleString('es', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' }) + ' UTC' : 'Sin lectura confirmada'; }

export function MondayOwnerPage() {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [connection, setConnection] = useState<MondayStatus | null>(null);
  const [boardId, setBoardId] = useState('');
  const [reading, setReading] = useState<Reading | null>(null);
  const [busy, setBusy] = useState<string | null>('initial');
  const [error, setError] = useState<string | null>(null);
  const csrfToken = useRef<string | null>(null);
  const operation = useRef(false);
  const loginForm = useRef<HTMLFormElement>(null);
  async function loadOwner(signal?: AbortSignal) {
    const current = ownerSession(await request('/owner/session', { signal }));
    let token: string | null = null, confirmed: MondayStatus | null = null;
    if (current.authenticated) { token = current.csrfToken; confirmed = status(await request('/status', { signal })); }
    else if (current.available) token = login(await request('/owner/login', { signal })).csrfToken;
    if (signal?.aborted) return;
    csrfToken.current = token; setSession(current); setConnection(confirmed); setReading(null);
    setBoardId(confirmed?.allowedBoards[0] ?? '');
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadOwner(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error instanceof MondayPageError ? error.message : ERROR_TEXT.offline); }).finally(() => { if (!controller.signal.aborted) setBusy(null); });
    return () => { controller.abort(); loginForm.current?.reset(); csrfToken.current = null; };
  }, []);
  async function run(name: string, action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError(null);
    try { await action(); }
    catch (error) {
      if (error instanceof MondayPageError && error.code === 'unauthorized') {
        setConnection(null); setReading(null); csrfToken.current = null; loginForm.current?.reset();
        try { await loadOwner(); } catch { setSession(null); }
      }
      const message = error instanceof MondayPageError ? error.message : ERROR_TEXT.offline;
      setError(name === 'login' && error instanceof MondayPageError && error.code === 'unauthorized' ? ERROR_TEXT.owner_login_failed : message);
    } finally { operation.current = false; setBusy(null); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const username = String(data.get('username') ?? ''), password = String(data.get('password') ?? '');
    form.reset();
    await run('login', async () => {
      if (!csrfToken.current) throw new MondayPageError('unauthorized');
      login(await request('/owner/login', { csrfToken: csrfToken.current, body: { username, password } }), true);
      await loadOwner();
    });
  }
  function change(path: '/refresh' | '/disconnect' | '/owner/logout') {
    void run(path, async () => {
      if (!csrfToken.current || !session?.authenticated) throw new MondayPageError('unauthorized');
      setReading(null);
      if (path === '/owner/logout') setConnection(null);
      await request(path, { csrfToken: csrfToken.current, body: {} });
      await loadOwner();
    });
  }
  function connect() {
    void run('oauth', async () => {
      if (!csrfToken.current || !session?.authenticated || !connection?.configured) throw new MondayPageError('forbidden');
      const target = authorizationUrl(await request('/oauth/start', { csrfToken: csrfToken.current, body: {} }));
      window.location.assign(target);
    });
  }
  function read(kind: Reading['kind']) {
    void run(kind, async () => {
      if (!csrfToken.current || !session?.authenticated || connection?.state !== 'connected' || !connection.boardAccessVerified || !connection.allowedBoards.includes(boardId)) throw new MondayPageError('forbidden');
      setReading(null);
      const result = readResult(await request(kind === 'board' ? '/read-board' : '/read-updates', { csrfToken: csrfToken.current, body: { boardId } }), kind, boardId);
      const confirmed = status(await request('/status'));
      setConnection(confirmed); if (confirmed.state === 'connected') setReading(result);
    });
  }
  const disabled = busy !== null;
  const mayRead = session?.authenticated && connection?.configured && connection.state === 'connected' && connection.boardAccessVerified && !connection.pending && connection.allowedBoards.includes(boardId);
  return <main className="office-main" style={{ maxWidth: 1000, padding: '24px 16px' }}>
    <header className="panel-heading"><div><p className="eyebrow">GOURMET AI OFFICE · INTEGRACIÓN</p><h1>Monday · acceso del propietario</h1><p>Acceso de integración autorizado por Ricardo · identidad Info.</p></div></header>
    {error && <p className="inline-alert" role="alert">{error}</p>}
    {busy === 'initial' && <p role="status">Comprobando acceso del propietario…</p>}
    {!session && busy !== 'initial' && <button className="button button-secondary" disabled={disabled} onClick={() => void run('access', () => loadOwner())}>Actualizar acceso</button>}
    {session && !session.available && <section className="wide-panel"><h2>Monday desactivado</h2><p>Monday desactivado. La configuración y el consentimiento están pendientes.</p></section>}
    {session?.available && !session.authenticated && <section className="wide-panel"><h2>Acceso de integración</h2><p>La sesión DEMO de la oficina no concede acceso a Monday.</p><form ref={loginForm} autoComplete="off" onSubmit={signIn}>
      <p><label htmlFor="monday-owner-username">Usuario del propietario</label><input id="monday-owner-username" name="username" required maxLength={100} autoComplete="off" disabled={disabled} style={{ display: 'block', width: '100%', maxWidth: 400, padding: 10, margin: '8px 0 16px' }} /></p>
      <p><label htmlFor="monday-owner-password">Contraseña del propietario</label><input id="monday-owner-password" name="password" type="password" required maxLength={512} autoComplete="off" disabled={disabled} style={{ display: 'block', width: '100%', maxWidth: 400, padding: 10, margin: '8px 0 16px' }} /></p>
      <button className="button button-primary" disabled={disabled || !csrfToken.current}>Entrar como propietario</button>
    </form></section>}
    {session?.authenticated && <section className="wide-panel" aria-label="Conexión Monday del propietario">
      <div className="panel-heading" style={{ flexWrap: 'wrap' }}><h2>Conexión de la identidad Info</h2><button className="button button-secondary" disabled={disabled} onClick={() => change('/owner/logout')}>Cerrar sesión del propietario</button></div>
      {connection && <>
        <h3 data-testid="monday-connection-state">{STATE_LABELS[connection.state]}</h3>
        {connection.state === 'disabled' && <p>Monday desactivado. La configuración y el consentimiento están pendientes.</p>}
        {connection.pending && <p className="inline-alert">Consentimiento pendiente. El estado conectado aún no está confirmado.</p>}
        {connection.code && <p>Código del servicio: <code>{connection.code}</code></p>}
        <dl className="approval-target"><div><dt>Actor Monday</dt><dd>{connection.actorId ?? 'Sin identidad confirmada'}</dd></div><div><dt>Cuenta configurada</dt><dd>{connection.configuredAccountId ? `${connection.configuredAccountId} · Sin verificar por OAuth` : 'Cuenta pendiente de configurar'}</dd></div><div><dt>Cuenta verificada por OAuth</dt><dd>Sin cuenta acreditada</dd></div><div><dt>Acceso a cinco tableros</dt><dd>{connection.boardAccessVerified ? 'Verificado por el servicio' : 'Sin acceso acreditado'}</dd></div><div><dt>Lectura del acceso a tableros</dt><dd>{at(connection.boardAccessReadAt)}</dd></div><div><dt>Scopes de lectura</dt><dd>{connection.scopes.join(', ') || 'Sin scopes confirmados'}</dd></div><div><dt>Lectura de identidad</dt><dd>{at(connection.identityReadAt)}</dd></div><div><dt>Conexión confirmada</dt><dd>{at(connection.connectedAt)}</dd></div><div><dt>Expiración del acceso</dt><dd>{at(connection.expiresAt)}</dd></div><div><dt>Última lectura</dt><dd>{at(connection.lastReadAt)}</dd></div></dl>
        <div className="approval-actions"><button className="button button-secondary" disabled={disabled} onClick={() => void run('status', () => loadOwner())}>Actualizar estado</button><button className="button button-primary" disabled={disabled || !connection.configured || connection.pending || connection.state === 'connected'} onClick={connect}>Conectar Monday</button><button className="button button-secondary" disabled={disabled || !connection.configured || !['connected', 'expired'].includes(connection.state)} onClick={() => change('/refresh')}>Renovar conexión</button><button className="button button-quiet" disabled={disabled || !connection.configured || connection.state === 'disconnected' || connection.state === 'disabled'} onClick={() => change('/disconnect')}>Desconectar Monday</button></div>
        <section className="work-section"><h3>Lectura de tableros autorizados</h3><p>La lectura conserva la procedencia y los límites indicados por el servicio.</p><label htmlFor="monday-board">Tablero autorizado</label><select id="monday-board" value={boardId} disabled={disabled || !mayRead} onChange={event => { setBoardId(event.target.value); setReading(null); }}>{connection.allowedBoards.length ? connection.allowedBoards.map(id => <option key={id} value={id}>Tablero {id}</option>) : <option value="">Sin tableros autorizados</option>}</select><div className="approval-actions"><button className="button button-secondary" disabled={disabled || !mayRead} onClick={() => read('board')}>Leer tablero</button><button className="button button-secondary" disabled={disabled || !mayRead} onClick={() => read('updates')}>Leer actualizaciones</button></div></section>
      </>}
      {reading && <section className="work-section" data-testid="monday-reading"><h3>{reading.kind === 'board' ? 'Lectura comercial del tablero' : 'Metadatos de actualizaciones'}</h3><p>{reading.result.status === 'complete' ? 'Lectura completa dentro del límite consultado' : reading.result.status === 'partial' ? 'Lectura parcial' : 'Lectura bloqueada'} · {reading.result.items.length} ítems · {reading.result.pages} páginas</p><p className="form-hint">Leído: {at(reading.result.readAt)} · Mapeo: {reading.result.mappingVersion}</p>{reading.result.reason && <p className="inline-alert">Código de lectura: {reading.result.reason}. Esta lectura no acredita datos fuera de su alcance.</p>}{reading.result.items.map(item => <article className="result-card" key={item.id}><h4>Ítem {item.id}</h4><p className="form-hint">Actualización de origen: {at(item.sourceUpdatedAt)} · Lectura: {at(item.readAt)}</p>{'columns' in item ? <dl className="approval-target">{item.columns.map(column => <div key={column.id}><dt>{FIELDS[column.field]}</dt><dd>{column.redacted ? 'Oculto por privacidad' : column.text ?? 'Sin valor confirmado'}</dd></div>)}</dl> : item.updates.map(update => <p key={update.id}>Actualización {update.id} · creación {at(update.createdAt)} · origen {at(update.sourceUpdatedAt)} · lectura {at(update.readAt)}</p>)}</article>)}</section>}
    </section>}
  </main>;
}
