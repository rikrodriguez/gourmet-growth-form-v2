import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type NavPage = 'overview' | 'funnel' | 'sessions' | 'leads' | 'attribution';
type User = { staff_user_id: string; email: string; role: 'admin' | 'viewer' };
type FilterState = { range: string; from: string; to: string; includeQa: boolean };
type ListSearch = { status: string; step: string; source: string; campaign: string; intent: string; id: string };

const NAV: Array<{ id: NavPage; label: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', glyph: '◫' },
  { id: 'funnel', label: 'Funnel', glyph: '▽' },
  { id: 'sessions', label: 'Sessions', glyph: '◎' },
  { id: 'leads', label: 'Leads', glyph: '◇' },
  { id: 'attribution', label: 'Attribution', glyph: '↗' },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    ...init,
  });
  if (response.status === 401) throw new Error('unauthorized');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? 'service_unavailable');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function query(filters: FilterState, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ range: filters.range, include_qa: String(filters.includeQa), ...extra });
  if (filters.range === 'custom') {
    params.set('from', filters.from);
    params.set('to', filters.to);
  }
  return params.toString();
}

function compactNumber(value: number) {
  return new Intl.NumberFormat('en-US', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value || 0);
}

function duration(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function when(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Los_Angeles', timeZoneName: 'short',
  }).format(new Date(value));
}

function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 8)}…` : '—';
}

function ErrorPanel({ error, retry }: { error: string; retry: () => void }) {
  return <div className="state-panel error-panel" role="alert">
    <div className="state-mark">!</div>
    <div><strong>Dashboard data is unavailable</strong><p>{error === 'invalid_filter' ? 'Review the selected filters.' : 'The secure data service could not answer this request.'}</p></div>
    <button onClick={retry}>Try again</button>
  </div>;
}

function Empty({ message }: { message: string }) {
  return <div className="state-panel"><div className="state-mark">0</div><div><strong>No matching data</strong><p>{message}</p></div></div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ user: User }>('/v1/admin/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      setPassword(''); onLogin(result.user);
    } catch (caught) {
      setPassword('');
      setError(caught instanceof Error && caught.message === 'rate_limited'
        ? 'Too many attempts. Wait before trying again.' : 'Email or password is incorrect.');
    } finally { setBusy(false); }
  }
  return <main className="login-shell">
    <section className="login-brand" aria-label="Gourmet Growth operations">
      <div className="brand-lockup"><span className="brand-mark">G</span><span>GOURMET CORPORATION</span></div>
      <div className="login-statement"><p className="eyebrow">FIRST-PARTY GROWTH OS</p><h1>Signals into service.</h1><p>Private funnel intelligence for the team turning Portland demand into remarkable events.</p></div>
      <div className="login-footnote"><span className="pulse" /> Secure staging environment</div>
    </section>
    <section className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <p className="eyebrow">STAFF ACCESS</p><h2>Welcome back</h2><p className="muted">Use your authorized Gourmet staff account.</p>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Verifying…' : 'Enter dashboard'}</button>
        <p className="security-note">Protected by encrypted staff sessions. Activity may be audited.</p>
      </form>
    </section>
  </main>;
}

function Filters({ value, onChange, refresh, polling, setPolling }: {
  value: FilterState; onChange: (next: FilterState) => void; refresh: () => void;
  polling: boolean; setPolling: (next: boolean) => void;
}) {
  return <div className="filter-bar">
    <label className="select-control"><span>Range</span><select value={value.range} onChange={(e) => onChange({ ...value, range: e.target.value })}>
      <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="custom">Custom</option>
    </select></label>
    {value.range === 'custom' && <div className="custom-dates"><label><span>From</span><input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></label><label><span>To</span><input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label></div>}
    <label className="toggle"><input type="checkbox" checked={value.includeQa} onChange={(e) => onChange({ ...value, includeQa: e.target.checked })} /><span className="toggle-track" /><span>Include QA</span></label>
    <label className="toggle"><input type="checkbox" checked={polling} onChange={(e) => setPolling(e.target.checked)} /><span className="toggle-track" /><span>Auto-refresh</span></label>
    <button className="icon-button" onClick={refresh} aria-label="Refresh dashboard">↻</button>
  </div>;
}

function MetricCard({ label, value, accent, note }: { label: string; value: string; accent?: boolean; note?: string }) {
  return <article className={`metric-card ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

function FunnelBars({ steps, compact = false }: { steps: any[]; compact?: boolean }) {
  if (!steps?.length) return <Empty message="No sessions reached the funnel in this range." />;
  const max = Math.max(1, ...steps.map((step) => step.entered));
  return <div className={`funnel-bars ${compact ? 'compact' : ''}`}>{steps.map((step, index) => <div className="funnel-row" key={step.step_id}>
    <div className="funnel-label"><span>{String(index + 1).padStart(2, '0')}</span><strong>{step.label}</strong></div>
    <div className="funnel-track"><div style={{ width: `${Math.max(2, (step.completed / max) * 100)}%` }} /></div>
    <div className="funnel-value"><strong>{compactNumber(step.completed)}</strong><span>{step.conversion_from_session_start}%</span></div>
  </div>)}</div>;
}

function Overview({ filters, nonce, unauthorized }: { filters: FilterState; nonce: number; unauthorized: () => void }) {
  const [data, setData] = useState<any>(null); const [funnel, setFunnel] = useState<any>(null); const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const suffix = query(filters);
      const [overview, funnelData] = await Promise.all([api<any>(`/v1/admin/overview?${suffix}`), api<any>(`/v1/admin/funnel?${suffix}`)]);
      setData(overview); setFunnel(funnelData);
    } catch (caught) { if (caught instanceof Error && caught.message === 'unauthorized') unauthorized(); else setError(caught instanceof Error ? caught.message : 'service_unavailable'); }
  }, [filters, unauthorized]);
  useEffect(() => { void load(); }, [load, nonce]);
  if (error) return <ErrorPanel error={error} retry={() => void load()} />;
  if (!data) return <div className="loading-grid" aria-label="Loading dashboard" />;
  const m = data.metrics;
  return <div className="page-stack">
    <section className="metric-grid five"><MetricCard label="Sessions" value={compactNumber(m.sessions)} note={`${compactNumber(m.unique_visitors)} unique`} /><MetricCard label="Leads" value={compactNumber(m.leads)} /><MetricCard label="Lead CVR" value={`${m.session_to_lead_conversion}%`} accent /><MetricCard label="Completed" value={compactNumber(m.completed)} /><MetricCard label="Complete CVR" value={`${m.session_to_complete_conversion}%`} /></section>
    <section className="panel wide"><div className="panel-heading"><div><p className="eyebrow">CONVERSION PATH</p><h2>Funnel movement</h2></div><span className="meta-chip">Median complete {duration(m.median_completion_ms)}</span></div><FunnelBars steps={funnel?.steps ?? []} compact /></section>
    <section className="split-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow">SESSION HEALTH</p><h2>Live state</h2></div></div><div className="status-summary"><div><span className="status-dot active" /><strong>{m.active_sessions}</strong><span>Active</span></div><div><span className="status-dot abandoned" /><strong>{m.abandoned_sessions}</strong><span>Abandoned</span></div><div><span className="status-dot complete" /><strong>{m.completed}</strong><span>Completed</span></div></div><p className="panel-note">Abandonment is derived after {data.abandonment_grace_minutes} minutes of inactivity.</p></article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">VELOCITY</p><h2>Time to completion</h2></div></div><div className="velocity"><strong>{duration(m.median_completion_ms)}</strong><span>median</span><div /><strong>{duration(m.average_completion_ms)}</strong><span>average</span></div><p className="panel-note">Median is primary to reduce outlier distortion.</p></article></section>
  </div>;
}

function FunnelPage({ filters, nonce, unauthorized }: { filters: FilterState; nonce: number; unauthorized: () => void }) {
  const [data, setData] = useState<any>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setData(await api(`/v1/admin/funnel?${query(filters)}`)); setError(''); } catch (e) { if (e instanceof Error && e.message === 'unauthorized') unauthorized(); else setError(e instanceof Error ? e.message : 'error'); } }, [filters, unauthorized]);
  useEffect(() => { void load(); }, [load, nonce]);
  if (error) return <ErrorPanel error={error} retry={() => void load()} />; if (!data) return <div className="loading-grid" />;
  return <div className="page-stack"><section className="metric-grid"><MetricCard label="Median to phone" value={duration(data.median_time_to_phone_ms)} accent /><MetricCard label="Median full completion" value={duration(data.median_full_completion_ms)} /></section><section className="panel wide"><div className="panel-heading"><div><p className="eyebrow">DISTINCT SESSIONS</p><h2>Eight-stage funnel</h2></div><span className="meta-chip">Duplicate events excluded</span></div><FunnelBars steps={data.steps} /></section><section className="panel table-panel"><table><thead><tr><th>Step</th><th>Entered</th><th>Completed</th><th>From previous</th><th>From start</th><th>Drop</th><th>Median time</th><th>Average time</th></tr></thead><tbody>{data.steps.map((step: any) => <tr key={step.step_id}><td><strong>{step.label}</strong></td><td>{step.entered}</td><td>{step.completed}</td><td>{step.conversion_from_previous}%</td><td>{step.conversion_from_session_start}%</td><td>{step.drop_count} · {step.drop_percentage}%</td><td>{duration(step.median_step_duration_ms)}</td><td>{duration(step.average_step_duration_ms)}</td></tr>)}</tbody></table></section></div>;
}

function Status({ value }: { value: string }) { return <span className={`status-pill ${value.toLowerCase()}`}><i />{value.replace('_', ' ')}</span>; }

function listQuery(search: ListSearch, cursor?: string | null) {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (key === 'id' && value.length !== 36) continue;
    if (value) extra[key === 'intent' ? 'intent_cluster' : key] = value;
  }
  if (cursor) extra.cursor = cursor;
  return extra;
}

function ListFilterControls({ value, onChange, sessions }: { value: ListSearch; onChange: (next: ListSearch) => void; sessions: boolean }) {
  return <div className="subfilters">
    {sessions && <label>Status<select value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value })}><option value="">All statuses</option><option>ACTIVE</option><option>LEAD_CAPTURED</option><option>COMPLETED</option><option>ABANDONED</option></select></label>}
    {sessions && <label>Step<select value={value.step} onChange={(e) => onChange({ ...value, step: e.target.value })}><option value="">All steps</option>{['guests','service','zip','phone','event_type','date','name','complete'].map((item) => <option key={item}>{item}</option>)}</select></label>}
    <label>Source<input value={value.source} maxLength={200} onChange={(e) => onChange({ ...value, source: e.target.value })} placeholder="Exact source" /></label>
    <label>Campaign<input value={value.campaign} maxLength={200} onChange={(e) => onChange({ ...value, campaign: e.target.value })} placeholder="Exact campaign" /></label>
    <label>Intent<input value={value.intent} maxLength={40} onChange={(e) => onChange({ ...value, intent: e.target.value })} placeholder="bbq" /></label>
    <label>{sessions ? 'Session ID' : 'Lead ID'}<input value={value.id} maxLength={36} onChange={(e) => onChange({ ...value, id: e.target.value })} placeholder="Exact UUID" /></label>
  </div>;
}

function DetailDrawer({ title, subtitle, children, close }: { title: string; subtitle: string; children: React.ReactNode; close: () => void }) {
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><aside className="drawer" role="dialog" aria-modal="true" aria-label={title}><div className="drawer-head"><div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Close details">×</button></div>{children}</aside></div>;
}

function SessionDetail({ id, includeQa, close }: { id: string; includeQa: boolean; close: () => void }) {
  const [data, setData] = useState<any>(null); const [copied, setCopied] = useState(false);
  useEffect(() => { void api<any>(`/v1/admin/sessions/${id}?range=7d&include_qa=${includeQa}`).then(setData); }, [id, includeQa]);
  if (!data) return <DetailDrawer title="Loading…" subtitle="SESSION" close={close}><div className="loading-grid" /></DetailDrawer>;
  const session = data.session;
  return <DetailDrawer title={shortId(session.session_id)} subtitle="SESSION DETAIL" close={close}><div className="detail-actions"><Status value={session.status} />{session.is_qa && <span className="qa-badge">QA</span>}<button onClick={() => { void navigator.clipboard.writeText(session.session_id); setCopied(true); }}>{copied ? 'Copied' : 'Copy session ID'}</button></div><dl className="detail-grid"><div><dt>Started</dt><dd>{when(session.started_at)}</dd></div><div><dt>Last activity</dt><dd>{when(session.last_seen_at)}</dd></div><div><dt>Current step</dt><dd>{session.last_step_id ?? '—'}</dd></div><div><dt>Lead</dt><dd>{session.lead_id ? 'Captured ✓' : 'Not captured'}</dd></div></dl><section className="drawer-section"><h3>Funnel answers</h3><div className="answer-grid">{Object.entries(data.answers).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></div>)}</div></section><section className="drawer-section"><h3>Attribution</h3>{data.attribution.map((touch: any) => <div className="touch-card" key={touch.touch_kind}><span>{touch.touch_kind} touch</span><strong>{touch.utm_source || 'Direct / unknown'}</strong><small>{touch.utm_campaign || 'No campaign'} · {touch.device || 'Unknown device'}</small></div>)}</section><section className="drawer-section"><h3>Event timeline</h3><ol className="timeline">{data.timeline.map((event: any) => <li key={event.event_id}><i /><div><strong>{event.event_name.replaceAll('_', ' ')}</strong><span>{event.step_id} · {when(event.occurred_at)}</span>{event.step_duration_ms !== null && <small>{duration(event.step_duration_ms)}</small>}</div></li>)}</ol></section></DetailDrawer>;
}

function Sessions({ filters, nonce, unauthorized }: { filters: FilterState; nonce: number; unauthorized: () => void }) {
  const [data, setData] = useState<any>(null); const [error, setError] = useState(''); const [detail, setDetail] = useState<string | null>(null); const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState<ListSearch>({ status: '', step: '', source: '', campaign: '', intent: '', id: '' });
  const load = useCallback(async (cursor?: string | null, append = false) => { try { if (append) setLoadingMore(true); const result = await api<any>(`/v1/admin/sessions?${query(filters, listQuery(search, cursor))}`); setData((previous: any) => append && previous ? { ...result, rows: [...previous.rows, ...result.rows] } : result); setError(''); } catch (e) { if (e instanceof Error && e.message === 'unauthorized') unauthorized(); else setError(e instanceof Error ? e.message : 'error'); } finally { setLoadingMore(false); } }, [filters, search, unauthorized]);
  useEffect(() => { void load(); }, [load, nonce]);
  if (error) return <ErrorPanel error={error} retry={() => void load()} />;
  return <div className="page-stack"><ListFilterControls value={search} onChange={setSearch} sessions /><section className="panel table-panel">{data && data.rows.length === 0 ? <Empty message="No sessions match this range and filter set." /> : <table><thead><tr><th>Status</th><th>Started</th><th>Last activity</th><th>Step</th><th>Guests</th><th>Service</th><th>ZIP</th><th>Lead</th><th>Source</th><th>Campaign</th><th>Device</th><th>Duration</th></tr></thead><tbody>{data?.rows.map((row: any) => <tr key={row.session_id} onClick={() => setDetail(row.session_id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setDetail(row.session_id); }}><td><Status value={row.status} />{row.is_qa && <span className="qa-badge">QA</span>}</td><td>{when(row.started_at)}</td><td>{when(row.last_activity)}</td><td>{row.last_step_id ?? '—'}</td><td>{row.guest_range ?? '—'}</td><td>{row.service_style ?? '—'}</td><td>{row.zip_code ?? '—'}</td><td>{row.lead_captured ? 'Yes ✓' : 'No'}</td><td>{row.source ?? 'Direct'}</td><td>{row.campaign ?? '—'}</td><td>{row.device ?? '—'}</td><td>{duration(row.duration_ms)}</td></tr>)}</tbody></table>}</section>{data?.next_cursor && <button className="load-more" disabled={loadingMore} onClick={() => void load(data.next_cursor, true)}>{loadingMore ? 'Loading…' : 'Load next 50'}</button>}{detail && <SessionDetail id={detail} includeQa={filters.includeQa} close={() => setDetail(null)} />}</div>;
}

function LeadDetail({ id, includeQa, close }: { id: string; includeQa: boolean; close: () => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { void api<any>(`/v1/admin/leads/${id}?range=7d&include_qa=${includeQa}`).then(setData); }, [id, includeQa]);
  if (!data) return <DetailDrawer title="Loading…" subtitle="LEAD" close={close}><div className="loading-grid" /></DetailDrawer>;
  return <DetailDrawer title={shortId(data.lead.lead_id)} subtitle="LEAD DETAIL" close={close}><div className="detail-actions"><span className="phone-safe">Phone captured ✓</span>{data.lead.is_qa && <span className="qa-badge">QA</span>}</div><dl className="detail-grid"><div><dt>Captured</dt><dd>{when(data.lead.created_at)}</dd></div><div><dt>Status</dt><dd>{data.lead.status}</dd></div><div><dt>Session</dt><dd>{shortId(data.lead.session_id)}</dd></div><div><dt>Intent</dt><dd>{data.lead.intent_cluster}</dd></div></dl><section className="drawer-section"><h3>Lead answers</h3><div className="answer-grid">{Object.entries(data.answers).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></div>)}</div></section><p className="privacy-callout">Phone contents remain encrypted and are intentionally unavailable in M1B.</p></DetailDrawer>;
}

function Leads({ filters, nonce, unauthorized }: { filters: FilterState; nonce: number; unauthorized: () => void }) {
  const [data, setData] = useState<any>(null); const [error, setError] = useState(''); const [detail, setDetail] = useState<string | null>(null); const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState<ListSearch>({ status: '', step: '', source: '', campaign: '', intent: '', id: '' });
  const load = useCallback(async (cursor?: string | null, append = false) => { try { if (append) setLoadingMore(true); const result = await api<any>(`/v1/admin/leads?${query(filters, listQuery(search, cursor))}`); setData((previous: any) => append && previous ? { ...result, rows: [...previous.rows, ...result.rows] } : result); setError(''); } catch (e) { if (e instanceof Error && e.message === 'unauthorized') unauthorized(); else setError(e instanceof Error ? e.message : 'error'); } finally { setLoadingMore(false); } }, [filters, search, unauthorized]);
  useEffect(() => { void load(); }, [load, nonce]); if (error) return <ErrorPanel error={error} retry={() => void load()} />;
  return <div className="page-stack"><ListFilterControls value={search} onChange={setSearch} sessions={false} /><section className="panel table-panel">{data && data.rows.length === 0 ? <Empty message="No leads were captured in this range." /> : <table><thead><tr><th>Captured</th><th>Status</th><th>Event</th><th>Guests</th><th>Service</th><th>ZIP</th><th>Time to lead</th><th>Source</th><th>Campaign</th><th>Completed</th><th>Session</th></tr></thead><tbody>{data?.rows.map((row: any) => <tr key={row.lead_id} onClick={() => setDetail(row.lead_id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setDetail(row.lead_id); }}><td>{when(row.created_at)}</td><td><strong>{row.status}</strong>{row.is_qa && <span className="qa-badge">QA</span>}</td><td>{row.event_type ?? '—'}</td><td>{row.guest_range ?? '—'}</td><td>{row.service_style ?? '—'}</td><td>{row.zip_code ?? '—'}</td><td>{duration(row.time_to_lead_ms)}</td><td>{row.source ?? 'Direct'}</td><td>{row.campaign ?? '—'}</td><td>{row.completed ? 'Yes ✓' : 'No'}</td><td>{shortId(row.session_id)}</td></tr>)}</tbody></table>}</section>{data?.next_cursor && <button className="load-more" disabled={loadingMore} onClick={() => void load(data.next_cursor, true)}>{loadingMore ? 'Loading…' : 'Load next 50'}</button>}{detail && <LeadDetail id={detail} includeQa={filters.includeQa} close={() => setDetail(null)} />}</div>;
}

function Attribution({ filters, nonce, unauthorized }: { filters: FilterState; nonce: number; unauthorized: () => void }) {
  const [data, setData] = useState<any>(null); const [error, setError] = useState(''); const [dimension, setDimension] = useState('utm_source');
  const load = useCallback(async () => { try { setData(await api(`/v1/admin/attribution?${query(filters)}`)); setError(''); } catch (e) { if (e instanceof Error && e.message === 'unauthorized') unauthorized(); else setError(e instanceof Error ? e.message : 'error'); } }, [filters, unauthorized]);
  useEffect(() => { void load(); }, [load, nonce]); if (error) return <ErrorPanel error={error} retry={() => void load()} />;
  const rows = data?.groups?.[dimension] ?? [];
  return <div className="page-stack"><div className="dimension-tabs" role="tablist">{['utm_source','utm_medium','utm_campaign','utm_term','device','network','geo'].map((item) => <button key={item} className={dimension === item ? 'active' : ''} onClick={() => setDimension(item)}>{item.replace('utm_', '')}</button>)}</div><section className="panel table-panel">{data && rows.length === 0 ? <Empty message="No attribution was captured for this dimension." /> : <table><thead><tr><th>{dimension.replaceAll('_', ' ')}</th><th>Sessions</th><th>Leads</th><th>Completed</th><th>Lead CVR</th><th>Complete CVR</th></tr></thead><tbody>{rows.map((row: any) => <tr key={row.value}><td><strong>{row.value}</strong></td><td>{row.sessions}</td><td>{row.leads}</td><td>{row.completed}</td><td>{row.session_to_lead_conversion}%</td><td>{row.session_to_complete_conversion}%</td></tr>)}</tbody></table>}</section></div>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<NavPage>('overview');
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [filters, setFilters] = useState<FilterState>({ range: '7d', from: today, to: today, includeQa: false });
  const [nonce, setNonce] = useState(0); const [polling, setPolling] = useState(false); const [mobileNav, setMobileNav] = useState(false);
  const unauthorized = useCallback(() => onLogout(), [onLogout]);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNonce((value) => value + 1); }, 30_000);
    return () => window.clearInterval(timer);
  }, [polling]);
  async function logout() { try { await api('/v1/admin/auth/logout', { method: 'POST', body: '{}' }); } finally { onLogout(); } }
  const title = NAV.find((item) => item.id === page)?.label ?? 'Overview';
  const content = page === 'overview' ? <Overview filters={filters} nonce={nonce} unauthorized={unauthorized} /> : page === 'funnel' ? <FunnelPage filters={filters} nonce={nonce} unauthorized={unauthorized} /> : page === 'sessions' ? <Sessions filters={filters} nonce={nonce} unauthorized={unauthorized} /> : page === 'leads' ? <Leads filters={filters} nonce={nonce} unauthorized={unauthorized} /> : <Attribution filters={filters} nonce={nonce} unauthorized={unauthorized} />;
  return <div className="dashboard-shell"><aside className={`sidebar ${mobileNav ? 'open' : ''}`}><div className="brand-lockup"><span className="brand-mark">G</span><span>GOURMET<br /><small>GROWTH OS</small></span></div><nav>{NAV.map((item) => <button className={page === item.id ? 'active' : ''} key={item.id} onClick={() => { setPage(item.id); setMobileNav(false); }}><i>{item.glyph}</i>{item.label}</button>)}</nav><div className="sidebar-foot"><span className="pulse" /> PostgreSQL live</div></aside><main className="workspace"><header className="topbar"><button className="menu-button" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation">☰</button><div><p className="eyebrow">GROWTH FORM V2</p><h1>{title}</h1></div><div className="topbar-user"><div><strong>{user.email}</strong><span>{user.role}</span></div><button onClick={() => void logout()}>Logout</button></div></header><div className="toolbar"><span className="timezone">Reporting timezone <strong>America/Los_Angeles</strong></span><Filters value={filters} onChange={setFilters} refresh={() => setNonce((value) => value + 1)} polling={polling} setPolling={setPolling} /></div>{filters.includeQa && <div className="qa-banner">QA traffic is included in this view.</div>}<div className="content">{content}</div></main></div>;
}

function Root() {
  const [user, setUser] = useState<User | null>(null); const [checking, setChecking] = useState(true);
  useEffect(() => { void api<{ user: User }>('/v1/admin/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setChecking(false)); }, []);
  if (checking) return <div className="boot-screen"><span className="brand-mark">G</span><p>Securing workspace…</p></div>;
  return user ? <Dashboard user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} />;
}

createRoot(document.getElementById('dashboard-root')!).render(<React.StrictMode><Root /></React.StrictMode>);
