import type { QuoteScope } from '../backend/event-quote-contracts';
import { EventQuoteClientError, validateQuoteStatus, validateQuoteView, type EventQuoteClient } from '../event-quote-client';

/** A projection from the existing server/session owner, never an identity chooser or tenant grant. */
export type DashboardQuoteGrant = {
  state: 'ready';
  /** Opaque, non-secret version of the existing operator identity. Never a credential. */
  identityKey: string;
  /** Opt-in durable transport revision, echoed by every JSON response. Never a credential. */
  serverRevision?: string;
  /** Existing operator durability from the trusted host, never a DEMO session flag. */
  durableIdentity: boolean;
  scope: QuoteScope;
  expiresAtMs: number;
  /** Explicit server-provided IDs, including any ID authorized for manual creation. No name matching. */
  eventIds: string[];
  permissions: { canRead: boolean; canWrite: boolean; canApprove: boolean };
  catalog: { ready: true; digest: string; validUntilMs: number; authority: 'test_only' | 'owner_authorized' };
};
export type DashboardQuoteAccess = DashboardQuoteGrant | { state: 'unconfigured' | 'unavailable' };
export interface DashboardQuoteAccessSource {
  read(signal: AbortSignal): Promise<DashboardQuoteAccess>;
  /** Notify synchronously on logout, identity/scope changes, or permission/catalogue withdrawal. */
  subscribe(onWithdraw: () => void): () => void;
}
export const unconfiguredDashboardQuoteAccess: DashboardQuoteAccessSource = {
  async read() { return { state: 'unconfigured' }; },
  subscribe() { return () => {}; },
};
/** Opt-in same-origin transport; the existing host owns withdrawal notifications.
 * No identity, event selector, proof or authority is sent by this source. */
export function createDashboardQuoteAccessSource(options: {
  subscribe: DashboardQuoteAccessSource['subscribe'];
  fetch?: typeof fetch;
  clock?: () => number;
}): DashboardQuoteAccessSource {
  const transport = options.fetch ?? globalThis.fetch;
  return {
    subscribe: onWithdraw => options.subscribe(onWithdraw),
    async read(signal) {
      if (signal.aborted) return cancelled();
      const response = await transport('/api/office/event-quotes/dashboard/access', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (signal.aborted) return cancelled();
      if (!response.ok) throw new EventQuoteClientError('DASHBOARD_ACCESS_UNAVAILABLE', response.status);
      if (!response.headers.get('content-type')?.includes('application/json')) return denied();
      const body = await response.text();
      if (body.length > 16_384) return denied();
      const value = JSON.parse(body);
      if (signal.aborted) return cancelled();
      const access = validateDashboardQuoteAccess(value, (options.clock ?? Date.now)());
      if (access.state === 'ready' && (!access.serverRevision || !access.durableIdentity || access.scope.mode !== 'test'
        || access.eventIds.length !== 1 || access.catalog.authority !== 'test_only')) return denied();
      return access;
    },
  };
}
const MAX_VIEW_LIFETIME = 15 * 60_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const plain = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeText = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const cancelled = (): never => { throw new EventQuoteClientError('REQUEST_CANCELLED'); };
const denied = (): never => { throw new EventQuoteClientError('DASHBOARD_ACCESS_WITHDRAWN', 403); };
export function quoteAccessExpiresAt(grant: DashboardQuoteGrant): number { return Math.min(grant.expiresAtMs, grant.catalog.validUntilMs); }

/** Validate and copy so later mutation of a DI response cannot silently broaden access. */
export function validateDashboardQuoteAccess(value: DashboardQuoteAccess, now = Date.now()): DashboardQuoteAccess {
  if (!plain(value)) return denied();
  if (value.state === 'unconfigured' || value.state === 'unavailable') return { state: value.state };
  if (value.state !== 'ready') return denied();
  const { identityKey, scope, permissions, catalog, eventIds } = value;
  if (!safeText(identityKey) || value.serverRevision !== undefined && (!safeText(value.serverRevision) || value.serverRevision !== identityKey)
    || typeof value.durableIdentity !== 'boolean' || !plain(scope) || !safeText(scope.organizationId) || !safeText(scope.workspaceId) || !['test', 'commercial'].includes(scope.mode)
    || scope.mode === 'commercial' && !value.durableIdentity
    || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= now
    || !plain(permissions) || !['canRead', 'canWrite', 'canApprove'].every(key => typeof permissions[key as keyof typeof permissions] === 'boolean') || !permissions.canRead
    || permissions.canApprove && !permissions.canWrite
    || !plain(catalog) || catalog.ready !== true || !/^[a-f0-9]{64}$/.test(catalog.digest) || !Number.isSafeInteger(catalog.validUntilMs) || catalog.validUntilMs <= now
    || !['test_only', 'owner_authorized'].includes(catalog.authority) || scope.mode === 'commercial' && catalog.authority !== 'owner_authorized'
    || !Array.isArray(eventIds) || eventIds.length > 1000 || new Set(eventIds).size !== eventIds.length
    || eventIds.some(id => typeof id !== 'string' || !ID.test(id) || ['status', 'constructor', 'prototype', '__proto__'].includes(id))) return denied();
  return {
    state: 'ready', identityKey, durableIdentity: value.durableIdentity, scope: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, mode: scope.mode },
    ...(value.serverRevision !== undefined ? { serverRevision: value.serverRevision } : {}),
    expiresAtMs: Math.min(value.expiresAtMs, now + MAX_VIEW_LIFETIME), eventIds: [...eventIds],
    permissions: { canRead: permissions.canRead, canWrite: permissions.canWrite, canApprove: permissions.canApprove },
    catalog: { ready: true, digest: catalog.digest, validUntilMs: catalog.validUntilMs, authority: catalog.authority },
  };
}

/** Abort plus generation prevents an adapter that ignores abort from restoring withdrawn access. */
export class DashboardQuoteAccessGate {
  private generation = 0;
  private controller: AbortController | null = null;
  start() {
    this.cancel();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    return { signal: controller.signal, current: () => this.generation === generation && !controller.signal.aborted };
  }
  cancel() { this.generation += 1; this.controller?.abort(); this.controller = null; }
}

/** UI-only ceiling; all authorization remains in the existing server identity resolver and service. */
export function bindDashboardQuoteClient(client: EventQuoteClient, input: DashboardQuoteGrant,
  lifetime: { signal: AbortSignal; current(): boolean }, clock: () => number = Date.now, onWithdraw: () => void = () => {}): EventQuoteClient {
  const access = validateDashboardQuoteAccess(input, clock());
  if (access.state !== 'ready') return denied();
  const grant = access;
  const assertCurrent = (eventId?: string, write = false, approve = false) => {
    if (!lifetime.current() || lifetime.signal.aborted) cancelled();
    if (quoteAccessExpiresAt(grant) <= clock()
      || eventId !== undefined && !grant.eventIds.includes(eventId)
      || write && !grant.permissions.canWrite || approve && !grant.permissions.canApprove) denied();
  };
  const protect = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (!signal.aborted && lifetime.current() && !lifetime.signal.aborted && error instanceof EventQuoteClientError && (error.status === 401 || error.status === 403 || error.code === 'INVALID_RESPONSE')) onWithdraw();
      throw error;
    }
  };
  const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  const checkView = (view: Awaited<ReturnType<EventQuoteClient['read']>>, eventId: string, signal: AbortSignal) => {
    assertCurrent(eventId); if (signal.aborted) cancelled();
    validateQuoteView(view, eventId);
    if (grant.serverRevision !== undefined && (!('accessRevision' in view) || view.accessRevision !== grant.serverRevision)) denied();
    if (view.record.scope.organizationId !== grant.scope.organizationId || view.record.scope.workspaceId !== grant.scope.workspaceId || view.record.scope.mode !== grant.scope.mode) denied();
    return view;
  };
  return {
    status: signal => protect(signal, async () => {
      assertCurrent(); if (signal.aborted) return cancelled();
      const status = validateQuoteStatus(await client.status(signalFor(signal), grant.serverRevision));
      assertCurrent(); if (signal.aborted) return cancelled();
      const readOnly = !status.enabled && status.reason === 'READ_ONLY' && !status.session.canWrite;
      if ((!status.enabled && !readOnly) || status.session.mode !== grant.scope.mode || status.session.expiresAtMs <= clock()
        || grant.serverRevision !== undefined && status.session.accessRevision !== grant.serverRevision
        || status.session.expiresAtMs < grant.expiresAtMs
        || !status.catalog || status.catalog.validUntilMs <= clock() || status.catalogDigest !== grant.catalog.digest || status.catalog.authority !== grant.catalog.authority) return denied();
      return { ...status, session: { ...status.session, canWrite: status.enabled && status.session.canWrite && grant.permissions.canWrite,
        canApprove: status.enabled && status.session.canWrite && status.session.canApprove && grant.permissions.canWrite && grant.permissions.canApprove, expiresAtMs: Math.min(status.session.expiresAtMs, quoteAccessExpiresAt(grant)) } };
    }),
    read: (eventId, signal) => protect(signal, async () => {
      assertCurrent(eventId); if (signal.aborted) return cancelled();
      return checkView(await client.read(eventId, signalFor(signal), grant.serverRevision), eventId, signal);
    }),
    execute: (eventId, command, csrfToken, signal) => protect(signal, async () => {
      assertCurrent(eventId, true, command.action === 'approve'); if (signal.aborted) return cancelled();
      return checkView(await client.execute(eventId, command, csrfToken, signalFor(signal), grant.serverRevision), eventId, signal);
    }),
  };
}
