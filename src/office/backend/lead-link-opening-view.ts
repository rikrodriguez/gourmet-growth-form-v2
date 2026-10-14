import { historicalLeadKey } from './lead-link-history';
import { projectLeadLinks, type LeadLinkScope } from './lead-link-view';
import { validateLeadLinkDestination, type LeadLinkAllowedDestination, type LeadLinkOpenRecord } from './lead-link-opening';
import type { LeadLinkResponseScope } from '../lead-link-response';
import type { LeadLinkView } from '../lead-link-view-contracts';
/** Only opaque opening references cross the read boundary. The POST re-resolves and reauthorizes them. */
export function projectOpenableLeadLinks(tenant: LeadLinkResponseScope, lead: LeadLinkScope, records: readonly LeadLinkOpenRecord[],
  campaignCatalogue: ReadonlyMap<string,string>, destinations: readonly LeadLinkAllowedDestination[]): LeadLinkView {
  const counts = new Map<string,number>();
  for (const record of records) counts.set(record.referenceId,(counts.get(record.referenceId) ?? 0)+1);
  return { leadId: lead.leadId, links: records.flatMap(record => {
    if (record.scope.organizationId !== tenant.organizationId || record.scope.workspaceId !== tenant.workspaceId || record.scope.mode !== tenant.mode
      || record.leadId !== lead.leadId || historicalLeadKey(record.sourceBinding) !== historicalLeadKey(lead)
      || historicalLeadKey(record.link.provenance) !== historicalLeadKey(lead)) return [];
    const view = projectLeadLinks(lead,[record.link],campaignCatalogue).links[0];
    if (!view) return [];
    const identifier = (v:string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) && !['constructor','prototype','__proto__'].includes(v);
    if (counts.get(record.referenceId) === 1 && identifier(record.referenceId) && identifier(record.revision)) {
      try { validateLeadLinkDestination(record.link,destinations); view.opening = { referenceId: record.referenceId, revision: record.revision }; }
      catch { /* Evidence remains readable; unavailable navigation never falls back to an unreviewed URL. */ }
    }
    return [view];
  }) };
}
