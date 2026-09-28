export const COMPLETION_SNAPSHOT_KEY = 'gourmet_growth_v2_completion_v1';
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export type CompletionSnapshot = {
  version: 1;
  completedAt: number;
  variant: string;
  firstName?: string;
  eventType?: string;
  guests?: string;
  service?: string;
  timing?: string;
};

function clean(value: string | undefined, maxLength = 80): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ').slice(0, maxLength);
  return normalized || undefined;
}

export function saveCompletionSnapshot(snapshot: Omit<CompletionSnapshot, 'version' | 'completedAt'>) {
  const safeSnapshot: CompletionSnapshot = {
    version: 1,
    completedAt: Date.now(),
    variant: clean(snapshot.variant, 40) ?? 'unknown',
    firstName: clean(snapshot.firstName, 60),
    eventType: clean(snapshot.eventType),
    guests: clean(snapshot.guests, 30),
    service: clean(snapshot.service, 40),
    timing: clean(snapshot.timing, 40),
  };
  try {
    window.sessionStorage.setItem(COMPLETION_SNAPSHOT_KEY, JSON.stringify(safeSnapshot));
  } catch {
    // Confirmation remains useful without browser storage.
  }
}

export function loadCompletionSnapshot(): CompletionSnapshot | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(COMPLETION_SNAPSHOT_KEY) ?? 'null') as CompletionSnapshot | null;
    if (!parsed || parsed.version !== 1 || Date.now() - parsed.completedAt > SNAPSHOT_TTL_MS) {
      window.sessionStorage.removeItem(COMPLETION_SNAPSHOT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
