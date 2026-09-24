import type { DashboardListFilters, ReportingRange, SessionStatus } from './contracts';

const TIMEZONE = 'America/Los_Angeles' as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STEP_IDS = new Set(['guests', 'service', 'zip', 'phone', 'event_type', 'date', 'name', 'complete']);
const STATUSES = new Set<SessionStatus>(['ACTIVE', 'LEAD_CAPTURED', 'COMPLETED', 'ABANDONED']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidDashboardFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDashboardFilterError';
  }
}

function localDateParts(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function zonedMidnight(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(candidate));
    const value = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const observed = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    candidate += desired - observed;
  }
  return new Date(candidate);
}

function one(query: Record<string, unknown>, key: string, maxLength = 200): string | null {
  const raw = query[key];
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > maxLength) throw new InvalidDashboardFilterError(`Invalid ${key}.`);
  return raw;
}

export function parseReportingRange(query: Record<string, unknown>, now = new Date()): ReportingRange {
  const preset = one(query, 'range', 20) ?? '7d';
  const includeQa = query.include_qa === 'true';
  if (query.include_qa !== undefined && query.include_qa !== 'true' && query.include_qa !== 'false') {
    throw new InvalidDashboardFilterError('Invalid include_qa.');
  }
  const today = localDateParts(now);
  let fromDate: string;
  let toDateExclusive: string;
  let label: string;

  if (preset === 'today') {
    fromDate = today; toDateExclusive = shiftDate(today, 1); label = 'Today';
  } else if (preset === 'yesterday') {
    fromDate = shiftDate(today, -1); toDateExclusive = today; label = 'Yesterday';
  } else if (preset === '7d' || preset === '30d') {
    const days = preset === '7d' ? 7 : 30;
    fromDate = shiftDate(today, -(days - 1)); toDateExclusive = shiftDate(today, 1); label = `Last ${days} days`;
  } else if (preset === 'custom') {
    const from = one(query, 'from', 10);
    const to = one(query, 'to', 10);
    if (!from || !to || !DATE_PATTERN.test(from) || !DATE_PATTERN.test(to) || from > to) {
      throw new InvalidDashboardFilterError('Invalid custom date range.');
    }
    if ((zonedMidnight(shiftDate(to, 1)).getTime() - zonedMidnight(from).getTime()) / 86_400_000 > 366) {
      throw new InvalidDashboardFilterError('Date range exceeds 366 days.');
    }
    fromDate = from; toDateExclusive = shiftDate(to, 1); label = `${from} – ${to}`;
  } else {
    throw new InvalidDashboardFilterError('Invalid range.');
  }

  return {
    from: zonedMidnight(fromDate),
    to: zonedMidnight(toDateExclusive),
    label,
    timezone: TIMEZONE,
    includeQa,
  };
}

export function parseListFilters(query: Record<string, unknown>, now = new Date()): DashboardListFilters {
  const range = parseReportingRange(query, now);
  const limitRaw = one(query, 'limit', 3);
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidDashboardFilterError('Invalid limit.');
  const status = one(query, 'status', 20) as SessionStatus | null;
  if (status && !STATUSES.has(status)) throw new InvalidDashboardFilterError('Invalid status.');
  const step = one(query, 'step', 40);
  if (step && !STEP_IDS.has(step)) throw new InvalidDashboardFilterError('Invalid step.');
  const exactId = one(query, 'id', 36);
  if (exactId && !UUID_PATTERN.test(exactId)) throw new InvalidDashboardFilterError('Invalid id.');
  return {
    ...range,
    limit,
    cursor: one(query, 'cursor', 500),
    status,
    step,
    source: one(query, 'source'),
    campaign: one(query, 'campaign'),
    intentCluster: one(query, 'intent_cluster', 40),
    exactId,
  };
}

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((value) => typeof value !== 'string')) throw new Error();
    if (!Number.isFinite(Date.parse(parsed[0])) || !UUID_PATTERN.test(parsed[1])) throw new Error();
    return parsed as [string, string];
  } catch {
    throw new InvalidDashboardFilterError('Invalid cursor.');
  }
}
