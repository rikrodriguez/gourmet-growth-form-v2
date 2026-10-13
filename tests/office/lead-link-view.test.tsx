import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadLinkHistoryPanel } from '../../src/office/LeadLinkHistoryPanel';
import { demoHistoricalRecords, leadLinkDemoViews } from '../../src/office/backend/lead-link-demo-fixtures';
import { projectLeadLinks } from '../../src/office/backend/lead-link-view';
import { normalizeHistoricalLink } from '../../src/office/backend/lead-link-history';
import projections from '../../src/office/lead-link-demo-projections.json';
const [history, other] = leadLinkDemoViews();
const agreement = Object.freeze({leadId:history.leadId,guests:45,menu:'Verified menu',amountLabel:'USD 900',verifiedAt:'2026-10-13T20:05:00Z',evidenceLabel:'Verified conversation'});
const render = () => renderToStaticMarkup(<LeadLinkHistoryPanel leadId={history.leadId} history={history} agreement={agreement}/>);
test('projected browser fixtures equal server output and contain no URLs or raw sensitive values',()=>{
 assert.deepEqual(projections,leadLinkDemoViews());
 for(const data of [JSON.stringify(projections),render()]) for(const secret of ['PRIVATE_','OTHER_LEAD_SECRET','https://','token=','name=']) assert.ok(!data.includes(secret));
});
test('exact account/board/item filtering isolates other lead and account',()=>{
 assert.equal(history.links.length,8);assert.equal(other.links.length,1);
 assert.equal(projectLeadLinks({leadId:'x',accountId:'other',boardId:'200',itemId:'300'},demoHistoricalRecords,new Map()).links.length,0);
 assert.equal(projectLeadLinks({leadId:'x',accountId:'demo-account',boardId:'other',itemId:'300'},demoHistoricalRecords,new Map()).links.length,0);
 assert.ok(history.links.every(l=>l.itemId==='300'));assert.ok(other.links.every(l=>l.itemId==='301'));
});
test('current agreement stays 45 while recorded request shows 50, without unsafe anchors or HTML',()=>{
 const html=render();assert.match(html,/45 invitados/);assert.match(html,/50 invitados/);assert.match(html,/Diferencia histórica/);assert.match(html,/Verified menu/);assert.match(html,/USD 900/);assert.equal(agreement.guests,45);
 assert.doesNotMatch(html,/<a |<iframe|<script|<img|href=|src=/);
 assert.match(html,/Otoño DEMO/);assert.match(html,/text_mm1kdqqb/);assert.match(html,/444/);
});
test('quarantined and missing links reveal no snapshot or campaign and cannot open',()=>{
 assert.equal(history.links[1].status,'missing');assert.equal(history.links[2].status,'quarantined');
 assert.equal(history.links[2].recordedGuests,null);assert.equal(history.links[2].campaignLabel,null);assert.doesNotMatch(render(),/900 invitados|PRIVATE_CAMPAIGN/);
});
test('unsafe URL schemes fail before rendering and arbitrary campaign/PII are not projected',()=>{
 const provenance=demoHistoricalRecords[0].provenance;
 for(const raw of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','file:///private']) assert.throws(()=>normalizeHistoricalLink({provenance,originalUrl:raw}));
 const l=normalizeHistoricalLink({provenance,originalUrl:'https://example.invalid/?guests=secret&utm_campaign=%3Cscript%3Ealert(1)%3C/script%3E'});
 const view=projectLeadLinks({leadId:'x',accountId:'demo-account',boardId:'200',itemId:'300'},[l],new Map());
 assert.equal(view.links[0].campaignLabel,null);assert.equal(view.links[0].recordedGuests,null);
 assert.doesNotMatch(JSON.stringify(view),/script|alert|secret/);
});
test('display guards against stale different-lead responses and escapes trusted labels',()=>{
 const html=renderToStaticMarkup(<LeadLinkHistoryPanel leadId={other.leadId} history={history} agreement={agreement}/>);
 assert.match(html,/fuera del lead/);assert.doesNotMatch(html,/45|50|300/);
 const malicious={...history,links:[{...history.links[0],campaignLabel:'<img src=x onerror=alert(1)>'}]};
 const escaped=renderToStaticMarkup(<LeadLinkHistoryPanel leadId={history.leadId} history={malicious} agreement={null}/>);
 assert.doesNotMatch(escaped,/<img/);assert.match(escaped,/&lt;img/);
});

test('later quote columns are historical snapshots and do not claim the first consultation',()=>{
 const quote=history.links.find(l=>l.category==='quote')!;
 assert.equal(quote.evidenceKind,'column_snapshot');assert.equal(quote.recordedGuests,60);
 assert.match(render(),/Consulta conservada en enlace: 60 invitados/);
 assert.doesNotMatch(render(),/Solicitud inicial:/);
});
test('Google indicators expose presence only, ignore empty values, and never prove a visit',()=>{
 assert.deepEqual(history.links.find(l=>l.category==='landing_attribution')!.attributionIndicators,['utm','google_click_id','google_campaign_id']);
 const raw=normalizeHistoricalLink({provenance:demoHistoricalRecords[0].provenance,originalUrl:'https://example.invalid/?gclid=&gad_campaignid=%20&utm_source='});
 const view=projectLeadLinks({leadId:'x',accountId:'demo-account',boardId:'200',itemId:'300'},[raw],new Map());
 assert.deepEqual(view.links[0].attributionIndicators,[]);
 assert.match(render(),/visita y conversión sin verificar/);
});

test('open controls contain only internal POST target and opaque references, never the private destination',()=>{
 const html=renderToStaticMarkup(<LeadLinkHistoryPanel leadId={history.leadId} history={history} agreement={agreement} openingContext={{identityKey:'synthetic-test-identity',csrfToken:'synthetic_test_csrf_not_credential',expiresAtMs:Date.now()+60000,current:()=>true}}/>);
 for(const part of ['action="/api/office/lead-link-open"','method="post"','target="_blank"','rel="noopener noreferrer"'])assert.ok(html.includes(part));
 for(const label of ['Abrir Calculator','Abrir AI Notes','Abrir AI Closer','Abrir Quotes'])assert.match(html,new RegExp(label));
 assert.doesNotMatch(html,/https:\/\/|SYNTHETIC_SIGNATURE|PRIVATE_|name="url"|href=|prefetch|ping=/);
 assert.match(html,/puede registrar la visita/);assert.match(html,/Referencia de atribución; navegación no habilitada/);
});
