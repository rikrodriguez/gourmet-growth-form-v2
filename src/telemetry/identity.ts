const VISITOR_STORAGE_KEY = 'gourmet_growth_telemetry_visitor_v1';
const SESSION_STORAGE_KEY = 'gourmet_growth_telemetry_session_v1';
const VISITOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type StoredVisitor = {
  version: 1;
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

type StoredSession = {
  version: 1;
  id: string;
  started_at: number;
};

export type TelemetryIdentity = {
  visitorId: string;
  sessionId: string;
  sessionStartedAt: number;
  isNewSession: boolean;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseVisitor(raw: string | null, now: number): StoredVisitor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredVisitor>;
    if (
      parsed.version === 1
      && isUuid(parsed.id)
      && typeof parsed.created_at === 'number'
      && typeof parsed.last_seen_at === 'number'
      && typeof parsed.expires_at === 'number'
      && parsed.expires_at > now
    ) {
      return parsed as StoredVisitor;
    }
  } catch {
    // Invalid first-party state is replaced with a fresh anonymous identifier.
  }
  return null;
}

function parseSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      parsed.version === 1
      && isUuid(parsed.id)
      && typeof parsed.started_at === 'number'
      && Number.isFinite(parsed.started_at)
    ) {
      return parsed as StoredSession;
    }
  } catch {
    // Invalid session state is replaced with a fresh anonymous session.
  }
  return null;
}

export function resolveTelemetryIdentity(now = Date.now()): TelemetryIdentity {
  let visitor = parseVisitor(window.localStorage.getItem(VISITOR_STORAGE_KEY), now);
  if (!visitor) {
    visitor = {
      version: 1,
      id: randomUuid(),
      created_at: now,
      last_seen_at: now,
      expires_at: now + VISITOR_TTL_MS,
    };
  } else {
    visitor = {
      ...visitor,
      last_seen_at: now,
      expires_at: now + VISITOR_TTL_MS,
    };
  }
  window.localStorage.setItem(VISITOR_STORAGE_KEY, JSON.stringify(visitor));

  let session = parseSession(window.sessionStorage.getItem(SESSION_STORAGE_KEY));
  const isNewSession = !session;
  if (!session) {
    session = { version: 1, id: randomUuid(), started_at: now };
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  return {
    visitorId: visitor.id,
    sessionId: session.id,
    sessionStartedAt: session.started_at,
    isNewSession,
  };
}
