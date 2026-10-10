import type { AreaId, Evidence, OfficeCase, WorkStatus } from './contracts';

// These helpers describe evidence. They never execute or approve an action.
function timestamp(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed).toISOString();
  return normalized === value || normalized.replace('.000Z', 'Z') === value ? parsed : null;
}

function compatibleEvidence(c: OfficeCase, evidence: Evidence | null): evidence is Evidence {
  if (!evidence || evidence.simulated !== c.evidence.simulated || !evidence.source.trim() || timestamp(evidence.at) === null) return false;
  // The scope belongs to the case, not to an editable closer label.
  return c.evidence.simulated
    ? evidence.reference.startsWith(`demo:${c.id}:`)
    : evidence.reference === c.id || evidence.reference.startsWith(`growth_v2:lead:${c.id}:`);
}

export function callTiming(c: OfficeCase): { attemptSeconds: number | null; connectedSeconds: number | null; met: boolean | null } {
  const captured = timestamp(c.capturedAt);
  if (captured === null || !compatibleEvidence(c, c.callEvidence)) return { attemptSeconds: null, connectedSeconds: null, met: null };
  const attempted = timestamp(c.attemptedAt);
  const connected = timestamp(c.connectedAt);
  const evidenceAt = timestamp(c.callEvidence.at)!;
  const attemptSeconds = attempted !== null && attempted >= captured && attempted <= evidenceAt ? (attempted - captured) / 1000 : null;
  const validConnection = c.humanContactVerified === true && connected !== null && connected >= captured
    && connected <= evidenceAt && (attempted === null || (attemptSeconds !== null && connected >= attempted));
  const connectedSeconds = validConnection ? (connected! - captured) / 1000 : null;
  return { attemptSeconds, connectedSeconds, met: connectedSeconds === null ? null : connectedSeconds <= 30 };
}

export function readyForExecution(c: OfficeCase): boolean {
  return c.saleClosed === true && c.payment === 'verified' && c.supplier === 'accepted'
    && compatibleEvidence(c, c.paymentEvidence) && compatibleEvidence(c, c.supplierEvidence);
}

const STATUS_PRIORITY: WorkStatus[] = ['failed', 'blocked', 'awaiting_approval', 'stale', 'running', 'queued', 'completed'];

export function deriveAreaStatus(c: OfficeCase, area: AreaId): WorkStatus {
  const tasks = c.tasks.filter(task => task.area === area);
  if (tasks.length === 0) return 'blocked';
  return STATUS_PRIORITY.find(status => tasks.some(task => task.status === status)) ?? 'blocked';
}
