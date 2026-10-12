import { randomBytes } from 'node:crypto';
import { MondayOAuthError, MONDAY_AUTHORIZED_USER_ID, type MondayOAuthService, type MondayOAuthStatus } from './monday-oauth';
import { MONDAY_READ_SCOPES } from './monday-read';
import type { MondayStore, MondayVault } from './monday-store';

const KEY = 'monday-renewal-ricardo';
const CHECK_MS = 60_000;
const MARGIN_MS = 15 * 60_000;
// Shorter than the OAuth refresh attempt's minimum 1003ms deadline. The
// attempted marker, rather than a lease alone, prevents replay after a crash.
const LEASE_MS = 1000;
export type MondayRenewalReason = 'grant_unavailable' | 'grant_changed' | 'contention' | 'storage_unavailable' | 'refresh_uncertain' | 'expiry_not_extended';
export type MondayRenewalStatus = {
  state: 'disabled' | 'idle' | 'scheduled' | 'refreshing' | 'backoff' | 'stopped' | 'suspended';
  reason: MondayRenewalReason | null; nextCheckAt: string | null; lastAttemptAt: string | null;
};
export type MondayRenewalTimers = { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
export type MondayRenewalOptions = {
  enabled?: boolean; service: Pick<MondayOAuthService, 'status' | 'refresh'>; store: MondayStore;
  vault: Pick<MondayVault, 'seal' | 'open'>; clock?: () => number; timers?: MondayRenewalTimers;
};
type Claim = { version: 1; id: string; grant: string; phase: 'claimed' | 'attempted' | 'finished' | 'retry' | 'suspended';
  expiresAt: number; leaseUntil: number; retryAt: number | null; reason: MondayRenewalReason | null };
const REASONS: readonly MondayRenewalReason[] = ['grant_unavailable', 'grant_changed', 'contention', 'storage_unavailable', 'refresh_uncertain', 'expiry_not_extended'];
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const result = Date.parse(value); return Number.isFinite(result) && new Date(result).toISOString() === value ? result : null;
}
function canonicalFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function valid(status: MondayOAuthStatus, now: number): boolean {
  return status.state === 'connected' && status.code === null && !status.pending && status.actorId === MONDAY_AUTHORIZED_USER_ID &&
    status.boardAccessVerified === true && canonicalFingerprint(status.grantFingerprint) && timestamp(status.expiresAt) !== null && timestamp(status.expiresAt)! > now &&
    status.scopes.length === MONDAY_READ_SCOPES.length && MONDAY_READ_SCOPES.every(scope => status.scopes.includes(scope));
}
function grant(status: MondayOAuthStatus): string {
  return status.grantFingerprint!;
}
function decode(value: unknown): Claim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const row = value as Record<string, unknown>;
  const keys = ['version', 'id', 'grant', 'phase', 'expiresAt', 'leaseUntil', 'retryAt', 'reason'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.version !== 1 ||
    typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.id) || typeof row.grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.grant) ||
    !['claimed', 'attempted', 'finished', 'retry', 'suspended'].includes(row.phase as string) ||
    !Number.isSafeInteger(row.expiresAt) || (row.expiresAt as number) < 0 ||
    !Number.isSafeInteger(row.leaseUntil) || (row.leaseUntil as number) < 0 ||
    row.retryAt !== null && (!Number.isSafeInteger(row.retryAt) || (row.retryAt as number) < 0) ||
    row.reason !== null && !REASONS.includes(row.reason as MondayRenewalReason)) throw new Error('invalid');
  return row as Claim;
}

/** Prepared server-only scheduling; runtime activation requires a separate review. */
export function createMondayRenewalScheduler(options: MondayRenewalOptions) {
  const enabled = options.enabled === true;
  const clock = options.clock ?? Date.now;
  const timers: MondayRenewalTimers = options.timers ?? { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let view: MondayRenewalStatus = { state: enabled ? 'idle' : 'disabled', reason: null, nextCheckAt: null, lastAttemptAt: null };
  let running = false; let busy = false; let epoch = 0; let timer: unknown; let scheduled = false; let failures = 0;
  const status = (): MondayRenewalStatus => ({ ...view });
  function suspend(reason: MondayRenewalReason) { view = { ...view, state: 'suspended', reason, nextCheckAt: null }; }
  function backoff(reason: MondayRenewalReason) {
    failures = Math.min(failures + 1, 5);
    view = { ...view, state: 'backoff', reason, nextCheckAt: new Date(clock() + Math.min(CHECK_MS * 2 ** (failures - 1), MARGIN_MS)).toISOString() };
  }
  async function save(revision: number | null, claim: Claim): Promise<boolean> {
    return options.store.compareAndSet(KEY, revision, options.vault.seal(claim, KEY));
  }
  async function tick(): Promise<MondayRenewalStatus> {
    if (!enabled || busy || view.state === 'suspended' || view.state === 'stopped') return status();
    if (view.state === 'backoff' && timestamp(view.nextCheckAt)! > clock()) return status();
    const turn = epoch; busy = true; let dispatched = false;
    const cancelled = () => turn !== epoch;
    try {
      const initial = await options.service.status(); if (cancelled()) return status();
      if (!valid(initial, clock())) { suspend('grant_unavailable'); return status(); }
      const expiry = timestamp(initial.expiresAt)!;
      if (expiry - clock() > MARGIN_MS) {
        failures = 0; view = { ...view, state: 'scheduled', reason: null, nextCheckAt: new Date(clock() + CHECK_MS).toISOString() }; return status();
      }
      const fingerprint = grant(initial);
      const stored = await options.store.read(KEY); if (cancelled()) return status();
      const previous = stored ? decode(options.vault.open(stored.value, KEY)) : null;
      if (previous && ['attempted', 'finished', 'suspended'].includes(previous.phase) && expiry <= previous.expiresAt) {
        suspend(previous.reason ?? (previous.grant === fingerprint ? 'refresh_uncertain' : 'expiry_not_extended')); return status();
      }
      if (previous?.grant === fingerprint && ['attempted', 'finished', 'suspended'].includes(previous.phase)) {
        suspend(previous.reason ?? 'refresh_uncertain'); return status();
      }
      if (previous && previous.leaseUntil > clock() || previous?.grant === fingerprint && previous.retryAt !== null && previous.retryAt > clock()) {
        backoff('contention'); return status();
      }
      const claim: Claim = { version: 1, id: randomBytes(32).toString('base64url'), grant: fingerprint, phase: 'claimed', expiresAt: expiry, leaseUntil: clock() + LEASE_MS, retryAt: null, reason: null };
      if (!await save(stored?.revision ?? null, claim)) { if (!cancelled()) backoff('contention'); return status(); }
      if (cancelled()) return status();
      const owned = await options.store.read(KEY); if (cancelled()) return status();
      if (!owned || decode(options.vault.open(owned.value, KEY)).id !== claim.id) { backoff('contention'); return status(); }
      const fresh = await options.service.status(); if (cancelled()) return status();
      if (!valid(fresh, clock()) || grant(fresh) !== fingerprint) { suspend('grant_changed'); return status(); }
      claim.phase = 'attempted';
      if (!await save(owned.revision, claim)) { if (!cancelled()) backoff('contention'); return status(); }
      if (cancelled()) return status();
      // From here onward a crash or unknown error is terminal for this grant.
      view = { ...view, state: 'refreshing', reason: null, nextCheckAt: null, lastAttemptAt: new Date(clock()).toISOString() };
      dispatched = true;
      let renewed: MondayOAuthStatus;
      try { renewed = await options.service.refresh({ expectedGrantFingerprint: fresh.grantFingerprint! }); }
      catch (error) {
        if (error instanceof MondayOAuthError && error.code === 'connection_changed') {
          if (!cancelled()) suspend('grant_changed'); return status();
        }
        // A contention code alone cannot prove where an operation failed.
        // The core discards the old pair before dispatch, so only a fresh,
        // valid unchanged grant can admit retry of a pre-dispatch conflict.
        if (error instanceof MondayOAuthError && error.code === 'operation_in_progress') {
          const unchanged = await options.service.status();
          if (cancelled()) return status();
          if (!valid(unchanged, clock()) || grant(unchanged) !== fingerprint) { suspend('refresh_uncertain'); return status(); }
          const current = await options.store.read(KEY);
          if (current && decode(options.vault.open(current.value, KEY)).id === claim.id) {
            const delay = Math.min(CHECK_MS * 2 ** Math.min(failures, 4), MARGIN_MS);
            await save(current.revision, { ...claim, phase: 'retry', leaseUntil: 0, retryAt: clock() + delay, reason: 'contention' });
          }
          if (!cancelled()) backoff('contention'); return status();
        }
        if (!cancelled()) suspend('refresh_uncertain'); return status();
      }
      let reason: MondayRenewalReason | null = !valid(renewed, clock()) ? 'refresh_uncertain' : timestamp(renewed.expiresAt)! <= expiry ? 'expiry_not_extended' : null;
      const current = await options.store.read(KEY);
      if (current && decode(options.vault.open(current.value, KEY)).id === claim.id) {
        // Keep an attempted marker if cleanup loses CAS; it is still fail-safe.
        await save(current.revision, { ...claim, grant: reason === 'expiry_not_extended' ? grant(renewed) : claim.grant, phase: reason ? 'suspended' : 'finished', leaseUntil: 0, reason });
      }
      if (cancelled()) return status();
      if (reason) suspend(reason);
      else { failures = 0; view = { ...view, state: 'scheduled', reason: null, nextCheckAt: new Date(clock() + CHECK_MS).toISOString() }; }
    } catch {
      if (!cancelled()) { if (dispatched) suspend('refresh_uncertain'); else backoff('storage_unavailable'); }
    } finally { busy = false; }
    return status();
  }
  function schedule() {
    if (!running || scheduled || view.state === 'suspended') return;
    const next = timestamp(view.nextCheckAt);
    scheduled = true;
    timer = timers.setTimeout(() => { scheduled = false; void run(); }, view.state === 'backoff' && next !== null ? Math.max(0, next - clock()) : CHECK_MS);
  }
  async function run() { const turn = epoch; await tick(); if (turn === epoch) schedule(); }
  function start() {
    if (!enabled || running || view.state === 'suspended') return;
    running = true; if (view.state === 'stopped') view = { ...view, state: 'idle', reason: null, nextCheckAt: null };
    void run();
  }
  function stop() {
    if (!enabled) return;
    running = false; epoch++;
    if (scheduled) { timers.clearTimeout(timer); scheduled = false; }
    view = { ...view, state: 'stopped', nextCheckAt: null };
  }
  return { start, stop, tick, status };
}
