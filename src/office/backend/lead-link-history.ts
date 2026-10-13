/** Server-only historical evidence. No I/O, renderer, canonical writes or tracking. */
export const LEAD_LINK_COLUMNS = Object.freeze({
  text_mm1kdqqb: 'calculator', link_mm4w75jc: 'lead_notes',
  link_mm5gbcxh: 'sales_closer', text_mm1er3gk: 'landing_attribution',
  text_mm1mkvn: 'quote', text_mm1epjsq: 'keyword',
} as const);
type Provenance = {
  accountId: string; boardId: string; itemId: string;
  columnId: string | null; updateId: string | null;
  observedAt: string; changedAt: string | null; originalValueType: string;
};
export type HistoricalLinkInput = { provenance: Provenance; originalUrl: string | null };
type Pair = readonly [string, string];
type Layer = { originalUrl: string; parameters: readonly Pair[]; campaignParameters: readonly Pair[] };
type Issue = 'item_mismatch' | 'board_mismatch' | 'ambiguous_identity' | 'session_mismatch' | 'invalid_nested_url' | 'ambiguous_source_url';
export type HistoricalLink = {
  schemaVersion: 1; provenance: Readonly<Provenance>; category: string;
  status: 'missing' | 'historical' | 'quarantined'; issues: readonly Issue[];
  outer: Layer | null; source: Layer | null; externalSessionId: string | null;
  evidenceKind: 'column_snapshot' | 'historical_update_link'; humanVisitEvidence: false;
};
const campaignKeys = new Set(['campaign', 'campaignid', 'gad_campaignid', 'gad_source', 'gclid', 'gbraid', 'wbraid', 'adgroupid', 'keyword', 'matchtype', 'device', 'network']);
function invalid(): never { throw new Error('Invalid historical link input'); }
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d?.enumerable || !('value' in d)) invalid();
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function timestamp(value: unknown): string {
  const s = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s.replace(/Z$/, s.includes('.') ? 'Z' : '.000Z')) invalid();
  return s;
}
function provenance(raw: unknown): Provenance {
  const p = record(raw);
  exactKeys(p, ['accountId','boardId','itemId','columnId','updateId','observedAt','changedAt','originalValueType']);
  const identifier = (v: unknown) => { const s = text(v, 128); if (!/^[a-zA-Z0-9_-]+$/.test(s)) invalid(); return s; };
  const result = {
    accountId: identifier(p.accountId), boardId: identifier(p.boardId), itemId: identifier(p.itemId),
    columnId: p.columnId === null ? null : identifier(p.columnId), updateId: p.updateId === null ? null : identifier(p.updateId),
    observedAt: timestamp(p.observedAt), changedAt: p.changedAt === null ? null : timestamp(p.changedAt),
    originalValueType: text(p.originalValueType, 64),
  };
  if ((result.columnId === null) === (result.updateId === null)) invalid();
  return result;
}
function layer(raw: unknown): Layer {
  const originalUrl = text(raw, 32768);
  // Strict absolute HTTP(S), no credentials, controls, whitespace, slashes repaired by URL.
  // This is syntax validation, NOT permission to fetch or navigate any host.
  if (!/^https?:\/\/[^/?#]/i.test(originalUrl) || /[\s\\]/.test(originalUrl)) invalid();
  let parsed: URL;
  try { parsed = new URL(originalUrl); } catch { invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) invalid();
  const parameters: Pair[] = [...parsed.searchParams.entries()];
  if (parameters.length > 256) invalid();
  return { originalUrl, parameters, campaignParameters: parameters.filter(([key]) => key.toLowerCase().startsWith('utm_') || campaignKeys.has(key.toLowerCase())) };
}
function values(l: Layer, key: string) { return l.parameters.filter(([k]) => k === key).map(([,v]) => v); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
/** Full result contains PII: restricted persistence only; never log or serialize into public APIs. */
export function normalizeHistoricalLink(input: HistoricalLinkInput): HistoricalLink {
  const r = record(input); exactKeys(r, ['provenance','originalUrl']);
  const p = provenance(r.provenance);
  const category = p.columnId === null ? 'update_link' : Object.hasOwn(LEAD_LINK_COLUMNS, p.columnId) ? LEAD_LINK_COLUMNS[p.columnId as keyof typeof LEAD_LINK_COLUMNS] : 'unmapped';
  const base = { schemaVersion: 1 as const, provenance: p, category, evidenceKind: p.updateId === null ? 'column_snapshot' as const : 'historical_update_link' as const, humanVisitEvidence: false as const };
  if (r.originalUrl === null || r.originalUrl === '') return freeze({ ...base, status: 'missing', issues: [], outer: null, source: null, externalSessionId: null });
  // A keyword column is plain text, not a URL. Caller must preserve it separately.
  if (category === 'keyword') invalid();
  const outer = layer(r.originalUrl), issues: Issue[] = [];
  let source: Layer | null = null;
  const nested = values(outer, 'sourceUrl');
  if (nested.length > 1) issues.push('ambiguous_source_url');
  else if (nested.length === 1) { try { source = layer(nested[0]); } catch { issues.push('invalid_nested_url'); } }
  const sessions: string[] = [];
  for (const l of [outer, source].filter((v): v is Layer => v !== null)) {
    for (const [key, expected, mismatch] of [['itemId', p.itemId, 'item_mismatch'], ['boardId', p.boardId, 'board_mismatch']] as const) {
      const actual = values(l, key);
      if (actual.length > 1) issues.push('ambiguous_identity');
      if (actual.some(v => v !== expected)) issues.push(mismatch);
    }
    const s = values(l, 'sessionId');
    if (s.length > 1 || s.some(v => !v)) issues.push('ambiguous_identity');
    sessions.push(...s);
  }
  if (new Set(sessions).size > 1) issues.push('session_mismatch');
  return freeze({ ...base, status: issues.length ? 'quarantined' : 'historical', issues: [...new Set(issues)], outer, source, externalSessionId: issues.length ? null : sessions[0] ?? null });
}
/** Exact source scope for a trusted upstream mapping; no name/session-based matching. */
export function historicalLeadKey(p: Pick<Provenance, 'accountId' | 'boardId' | 'itemId'>): string {
  return JSON.stringify([text(p.accountId), text(p.boardId), text(p.itemId)]);
}
/** Safe operational summary: never contains URL, host/path, query, IDs or campaign values. */
export function summarizeHistoricalLink(link: HistoricalLink) {
  return { schemaVersion: link.schemaVersion, status: link.status, category: link.category,
    issues: [...link.issues], hasAttribution: Boolean(link.outer?.campaignParameters.length || link.source?.campaignParameters.length),
    evidenceKind: link.evidenceKind, humanVisitEvidence: false as const };
}
/** Neutral historical comparison only. Returns no canonical patch and picks no winning source. */
export function historicalParameterDifferences(link: HistoricalLink, current: Readonly<Record<string, string>>) {
  if (link.status !== 'historical') return [];
  return (link.outer?.parameters ?? []).filter(([key, value]) => Object.hasOwn(current, key) && current[key] !== value)
    .map(([parameter, initialValue]) => ({ parameter, initialValue, currentValue: current[parameter], relationship: 'historical_difference' as const }));
}
/** Compare operational snapshots already joined by trusted account/board/item, never by session. */
export function historicalSessionConsistency(links: readonly HistoricalLink[]): 'consistent' | 'different' | 'unknown' {
  if (!links.length || links.some(l => l.status !== 'historical' || !l.externalSessionId)) return 'unknown';
  if (new Set(links.map(l => historicalLeadKey(l.provenance))).size !== 1) invalid();
  return new Set(links.map(l => l.externalSessionId)).size === 1 ? 'consistent' : 'different';
}
