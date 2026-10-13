export type LeadLinkView = {
  leadId: string;
  links: { opening: { referenceId: string; revision: string } | null; category: string; status: 'missing' | 'historical' | 'quarantined';
    accountId: string; boardId: string; itemId: string; columnId: string | null; updateId: string | null;
    evidenceKind: 'column_snapshot' | 'historical_update_link';
    attributionIndicators: ('utm' | 'google_click_id' | 'google_campaign_id')[];
    observedAt: string; changedAt: string | null; campaignLabel: string | null; recordedGuests: number | null }[];
};
export type VerifiedLeadAgreement = { leadId: string; guests: number; menu: string; amountLabel: string; verifiedAt: string; evidenceLabel: string };
