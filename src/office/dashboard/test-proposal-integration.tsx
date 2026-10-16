import React, { type ReactNode } from 'react';
import { PersistedQuoteWorkspace } from './PersistedQuoteWorkspace';
import { ExternalProposalPanel } from './ExternalProposalPanel';
import { validateLeadLinkAccess, type DashboardLeadLinkAccessSource, type DashboardLeadLinkGrant, type LeadLinkClient } from './lead-link-access';
import { validateQuoteStatus, validateQuoteView, type EventQuoteClient } from '../event-quote-client';
import { TEST_PROPOSAL_API as API, TEST_PROPOSAL_IDENTITY, TEST_PROPOSAL_CSRF, type ExternalProposalClient, type ExternalProposalView, type ProposalTarget } from '../external-proposal-contracts';

export interface TestProposalDashboardIntegration {
  source: DashboardLeadLinkAccessSource;
  historyClient: LeadLinkClient;
  renderForLead(context: { leadId: string; identityKey: string }): ReactNode;
}
type Context = { access: DashboardLeadLinkGrant; target: ProposalTarget; csrfToken: string; epoch: number };
const deny = (): never => { throw new Error('Test proposal context unavailable'); };
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value)
  && !['constructor', 'prototype', '__proto__', 'status', 'session', 'grant', 'grants'].includes(value);
const sameTarget = (a: ProposalTarget, b: ProposalTarget) => a.leadId === b.leadId && a.eventId === b.eventId && a.proposalId === b.proposalId;

/** Explicit TEST_ONLY composition. The host supplies an existing read-only quote
 * transport and withdrawal subscription. No mount, session or request on creation.
 * Only the server's verified single-case projection selects the three IDs. */
export function createTestProposalDashboardIntegration(options: {
  quoteClient: EventQuoteClient;
  subscribe: DashboardLeadLinkAccessSource['subscribe'];
  fetch?: typeof fetch;
}): TestProposalDashboardIntegration {
  const transport = options.fetch ?? globalThis.fetch;
  let context: Context | null = null, epoch = 0;
  let rendered: { context: Context; node: ReactNode } | null = null;
  const clear = () => { context = null; rendered = null; epoch++; };
  function current(value: Context, signal?: AbortSignal) {
    if (signal?.aborted || context !== value || value.epoch !== epoch || value.access.expiresAtMs <= Date.now()) return deny();
    return value;
  }
  async function request(path: string, signal: AbortSignal, value?: Context, command?: unknown): Promise<unknown> {
    if (value) current(value, signal);
    if (signal.aborted) return deny();
    const response = await transport(`${API}/${path}`, { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(value ? { [TEST_PROPOSAL_IDENTITY]: value.access.identityKey } : {}),
        ...(command && value ? { 'Content-Type': 'application/json', [TEST_PROPOSAL_CSRF]: value.csrfToken } : {}) },
      body: command ? JSON.stringify(command) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return deny();
    const body = await response.text();
    if (body.length > 262_144 || signal.aborted) return deny();
    if (value) current(value, signal);
    return JSON.parse(body);
  }
  const source: DashboardLeadLinkAccessSource = {
    async read(signal) {
      clear(); const started = epoch;
      const raw = await request('access', signal) as Record<string, unknown>;
      if (signal.aborted || epoch !== started || !raw || typeof raw !== 'object') return deny();
      const access = validateLeadLinkAccess(raw.access);
      const target = raw.target as ProposalTarget | undefined;
      if (access.state !== 'ready' || access.scope.mode !== 'test' || !access.durableIdentity || access.canOpen
        || !/^proposal-[A-Za-z0-9_-]{43}$/.test(access.identityKey) || access.leadIds.length !== 1
        || !target || Object.keys(target).sort().join(',') !== 'eventId,leadId,proposalId'
        || !id(target.leadId) || !id(target.eventId) || !id(target.proposalId) || target.leadId !== access.leadIds[0]
        || typeof raw.csrfToken !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(raw.csrfToken)) return deny();
      context = { access: structuredClone(access), target: structuredClone(target), csrfToken: raw.csrfToken, epoch };
      return structuredClone(access);
    },
    subscribe(listener) {
      const unsubscribe = options.subscribe(() => { clear(); listener(); });
      if (typeof unsubscribe !== 'function') { clear(); return deny(); }
      return () => { clear(); unsubscribe(); };
    },
  };
  const historyClient: LeadLinkClient = { async read(leadId, signal) {
    const value = context; if (!value || leadId !== value.target.leadId) return deny();
    // LeadLinkHistorySection's existing bound client validates identity/scope/lead.
    return await request('history', signal, value) as Awaited<ReturnType<LeadLinkClient['read']>>;
  } };
  function renderForLead({ leadId, identityKey }: { leadId: string; identityKey: string }) {
    const value = context;
    if (!value || value.access.identityKey !== identityKey || value.target.leadId !== leadId || value.access.expiresAtMs <= Date.now()) return null;
    if (rendered?.context === value) return rendered.node;
    const quotes: EventQuoteClient = {
      async status(signal) {
        current(value, signal);
        const result = validateQuoteStatus(await options.quoteClient.status(signal, identityKey)); current(value, signal);
        if (result.session.mode !== 'test' || result.session.canWrite || result.session.canApprove || result.externalEffectsEnabled !== false
          || !result.catalog || result.catalog.authority !== 'test_only') return deny();
        return result;
      },
      async read(eventId, signal) {
        current(value, signal); if (eventId !== value.target.eventId) return deny();
        const result = validateQuoteView(await options.quoteClient.read(eventId, signal, identityKey), eventId); current(value, signal);
        const scope = result.record.scope;
        if (scope.mode !== 'test' || scope.organizationId !== value.access.scope.organizationId || scope.workspaceId !== value.access.scope.workspaceId) return deny();
        return result;
      },
      async execute() { return deny(); },
    };
    const proposals: ExternalProposalClient = {
      // ExternalProposalPanel validates and detaches every response, including
      // target/scope/identity, immutable metadata and SHA-256, before displaying it.
      async read(target, signal) { if (!sameTarget(target, value.target)) return deny(); return await request('proposal', signal, value) as ExternalProposalView; },
      async execute(target, command, signal) { if (!sameTarget(target, value.target)) return deny(); return await request('commands', signal, value, command) as ExternalProposalView; },
    };
    const node = <PersistedQuoteWorkspace key={JSON.stringify([identityKey, value.target])} client={quotes} identityKey={identityKey} eventId={value.target.eventId}
      externalProposal={({ briefDigest, dirty }) => !dirty && briefDigest ? <ExternalProposalPanel key={briefDigest} client={proposals} target={value.target} identityKey={identityKey} scope={value.access.scope} /> : null} />;
    rendered = { context: value, node }; return node;
  }
  return { source, historyClient, renderForLead };
}
