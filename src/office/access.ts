import type { DemoSession } from './adapter';
import type { OfficeCommand } from './contracts';

export type OfficeWriteTarget = Pick<OfficeCommand, 'caseId' | 'functionId'>;

// UI affordance only. The API checks the same target again before execution
// and replay; navigation and the role chooser never grant write permission.
export function canWriteFor(
  session: DemoSession | null,
  target: OfficeWriteTarget | null,
  nowMs: number,
  pendingCommand: OfficeCommand | null,
): boolean {
  if (!session || !target || pendingCommand || session.role !== 'operator' || !Number.isFinite(nowMs)) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs)
    && expiresAtMs > nowMs
    && session.caseIds.includes(target.caseId)
    && session.functionIds.includes(target.functionId);
}
