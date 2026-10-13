import { normalizeHistoricalLink as normalize } from './lead-link-history';
import { projectOpenableLeadLinks } from './lead-link-opening-view';
import { REVIEWED_LEAD_LINK_DESTINATIONS, type LeadLinkOpenRecord, type LeadLinkAllowedDestination } from './lead-link-opening';
const scope = { leadId:'demo-history-a',accountId:'demo-account',boardId:'200',itemId:'300' };
const provenance = { accountId:scope.accountId,boardId:scope.boardId,itemId:scope.itemId,columnId:'text_mm1kdqqb',updateId:null,observedAt:'2026-10-13T20:00:00Z',changedAt:null,originalValueType:'text' };
export const demoHistoricalRecords = [
 normalize({provenance,originalUrl:'https://monday.gourmet-corporation.com/?guests=50&itemId=300&boardId=200&utm_campaign=demo-autumn&name=PRIVATE_SYNTHETIC_NAME&phone=PRIVATE_SYNTHETIC_PHONE&token=PRIVATE_SYNTHETIC_TOKEN'}),
 normalize({provenance:{...provenance,columnId:'link_mm4w75jc'},originalUrl:null}),
 normalize({provenance:{...provenance,columnId:'link_mm5gbcxh'},originalUrl:'https://example.invalid/?itemId=999&guests=900&utm_campaign=PRIVATE_CAMPAIGN'}),
 normalize({provenance:{...provenance,columnId:null,updateId:'444'},originalUrl:'https://files.invalid/PRIVATE_DOCUMENT.pdf'}),
 normalize({provenance:{...provenance,columnId:'text_mm1er3gk'},originalUrl:'https://example.invalid/landing?utm_source=google&gclid=PRIVATE_CLICK&gad_campaignid=PRIVATE_CAMPAIGN_ID'}),
 normalize({provenance:{...provenance,columnId:'text_mm1mkvn',changedAt:'2026-10-13T19:55:00Z'},originalUrl:'https://gourmet-corporation.com/quote/synthetic-quote.pdf?guests=60&signature=SYNTHETIC_SIGNATURE%2BKEEP%2FEXACT'}),
 normalize({provenance:{...provenance,columnId:'link_mm4w75jc'},originalUrl:'https://gourmet-corporation.com/lead-ai/?boardId=200&itemId=300&sessionId=synthetic_session'}),
 normalize({provenance:{...provenance,columnId:'link_mm5gbcxh'},originalUrl:'https://gourmet-corporation.com/aisalescloser/?boardId=200&itemId=300&sessionId=synthetic_session'}),
 normalize({provenance:{...provenance,itemId:'301'},originalUrl:'https://example.invalid/?guests=80&name=OTHER_LEAD_SECRET'}),
];
export const demoOpeningScope = { organizationId:'synthetic-org',workspaceId:'synthetic-workspace',mode:'test' as const };
export const demoOpeningDestinations: readonly LeadLinkAllowedDestination[] = [...REVIEWED_LEAD_LINK_DESTINATIONS,{category:'quote',origin:'https://gourmet-corporation.com',pathname:'/quote/synthetic-quote.pdf'}];
export const demoOpeningRecords: readonly LeadLinkOpenRecord[] = demoHistoricalRecords.map((link,index)=>({
 scope:demoOpeningScope,leadId:link.provenance.itemId === '300' ? 'demo-history-a' : 'demo-history-b',referenceId:`synthetic-reference-${index}`,revision:'synthetic-revision-1',
 sourceBinding:{accountId:link.provenance.accountId,boardId:link.provenance.boardId,itemId:link.provenance.itemId},link,
}));
export function leadLinkDemoViews() {
 return [projectOpenableLeadLinks(demoOpeningScope,scope,demoOpeningRecords,new Map([['demo-autumn','Otoño DEMO']]),demoOpeningDestinations),
  projectOpenableLeadLinks(demoOpeningScope,{...scope,leadId:'demo-history-b',itemId:'301'},demoOpeningRecords,new Map(),demoOpeningDestinations)];
}
