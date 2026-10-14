import { historicalLeadKey, type HistoricalLink } from './lead-link-history';
import type { LeadLinkView } from '../lead-link-view-contracts';
/** Internal server scope must come from an authenticated, authorized mapping, never request parameters alone. */
export type LeadLinkScope = { leadId: string; accountId: string; boardId: string; itemId: string };
/** No arbitrary URL/query value crosses this boundary. Approved campaign names come from a trusted catalogue. */
export function projectLeadLinks(scope: LeadLinkScope, records: readonly HistoricalLink[], campaignCatalogue: ReadonlyMap<string, string>): LeadLinkView {
  const key = historicalLeadKey(scope);
  return { leadId: scope.leadId, links: records.filter(l => historicalLeadKey(l.provenance) === key).map(l => {
    const campaignValues = [l.outer, l.source].flatMap(layer => layer?.campaignParameters.filter(([k]) => k === 'utm_campaign').map(([, v]) => v) ?? []);
    const unique = [...new Set(campaignValues)];
    const guestValues = l.outer?.parameters.filter(([k]) => k === 'guests' || k === 'guestCount').map(([,v]) => v) ?? [];
    const guests = guestValues.length === 1 && /^[1-9]\d{0,4}$/.test(guestValues[0]) ? Number(guestValues[0]) : null;
    return { opening: null, category: l.category, status: l.status,
      accountId: l.provenance.accountId, boardId: l.provenance.boardId, itemId: l.provenance.itemId,
      columnId: l.provenance.columnId, updateId: l.provenance.updateId,
      evidenceKind: l.evidenceKind,
      attributionIndicators: l.status !== 'historical' ? [] : [...new Set([l.outer, l.source].flatMap(layer => layer?.campaignParameters.flatMap(([key, value]) => {
        if (!value.trim()) return [];
        const k = key.toLowerCase();
        return k.startsWith('utm_') ? ['utm' as const] : ['gclid','gbraid','wbraid'].includes(k) ? ['google_click_id' as const] : k === 'gad_campaignid' ? ['google_campaign_id' as const] : [];
      }) ?? []))],
      observedAt: l.provenance.observedAt, changedAt: l.provenance.changedAt,
      campaignLabel: l.status === 'historical' && unique.length === 1 ? campaignCatalogue.get(unique[0]) ?? null : null,
      recordedGuests: l.status === 'historical' && l.provenance.updateId === null ? guests : null };
  }) };
}
