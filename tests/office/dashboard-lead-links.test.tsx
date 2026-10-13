import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPage } from '../../src/office/DashboardPage';
import { LeadLinkHistorySection } from '../../src/office/dashboard/LeadLinkHistorySection';
import { bindLeadLinkClient, LeadLinkReadGate, unconfiguredLeadLinkAccess, validateLeadLinkAccess,
  type DashboardLeadLinkGrant, type LeadLinkClient } from '../../src/office/dashboard/lead-link-access';
import type { LeadLinkResponse } from '../../src/office/lead-link-response';
import { leadLinkDemoViews } from '../../src/office/backend/lead-link-demo-fixtures';
import { dashboardFixtureSource } from '../../src/office/dashboard/source';
const now=Date.parse('2026-10-13T20:00:00Z');
const scope={organizationId:'test-org',workspaceId:'test-workspace',mode:'test' as const};
const [history]=leadLinkDemoViews();
function grant():DashboardLeadLinkGrant{return {state:'ready',identityKey:'test-identity-v1',durableIdentity:false,scope:{...scope},expiresAtMs:now+60_000,canRead:true,canOpen:false,leadIds:[history.leadId]};}
function response():LeadLinkResponse{return {identityKey:'test-identity-v1',scope:{...scope},leadId:history.leadId,history:{...history,links:history.links.map(link=>({...link,opening:null}))},agreement:null,openingSession:{canOpen:false,csrfToken:null,expiresAtMs:now+60_000}};}
const signal=()=>new AbortController().signal;
const gate=()=>new LeadLinkReadGate().start();

test('saved Dashboard mounts closed lead history without connecting to any source or client',async()=>{
 const snapshot=await dashboardFixtureSource.read(signal());let calls=0;
 const source={async read(){calls++;return grant();},subscribe(){calls++;return()=>{};}};
 const client:LeadLinkClient={async read(){calls++;return response();}};
 for(const initialSection of ['events','quotes'] as const){
  const html=renderToStaticMarkup(<DashboardPage initialSection={initialSection} initialSnapshot={snapshot} leadLinkAccessSource={source} leadLinkClient={client}/>);
  assert.match(html,/dashboard-lead-history/);assert.match(html,/Acceso cerrado/);assert.doesNotMatch(html,/Consulta conservada en enlace:|demo-history-a|<select/);
 }
 assert.equal(calls,0);
});
test('DEMO mode never mounts saved lead access and default source is inert',async()=>{
 const snapshot=await dashboardFixtureSource.read(signal());
 const html=renderToStaticMarkup(<DashboardPage initialSection="events" initialEventMode="demo" initialSnapshot={snapshot}/>);
 assert.doesNotMatch(html,/dashboard-lead-history|Lead autorizado/);
 assert.deepEqual(await unconfiguredLeadLinkAccess.read(signal()),{state:'unconfigured'});
 assert.match(renderToStaticMarkup(<LeadLinkHistorySection/>),/Sin fuente de historial configurada/);
});
test('access rejects expired, malformed, broad, commercial-ephemeral and read-denied grants',()=>{
 for(const change of [{expiresAtMs:now},{canRead:false},{leadIds:['../x']},{leadIds:[history.leadId,history.leadId]},{leadIds:['__proto__']},{identityKey:''},{scope:{...scope,mode:'commercial'}},{scope:{...scope,workspaceId:''}}]){
  assert.throws(()=>validateLeadLinkAccess({...grant(),...change},now));
 }
});
test('grant copies are isolated and their display lifetime is at most fifteen minutes',()=>{
 const input=grant();input.expiresAtMs=now+99999999;
 const safe=validateLeadLinkAccess(input,now);assert.equal(safe.state,'ready');if(safe.state!=='ready')return;
 input.leadIds.push('other');input.scope.workspaceId='other';
 assert.equal(safe.expiresAtMs,now+900000);assert.deepEqual(safe.leadIds,[history.leadId]);assert.equal(safe.scope.workspaceId,'test-workspace');
});
test('bound client reads only the explicit authorized lead and returns a safe copy',async()=>{
 const calls:string[]=[];const original=response();
 const bound=bindLeadLinkClient({async read(id){calls.push(id);return original;}},grant(),gate(),()=>now);
 await assert.rejects(()=>bound.read('other',signal()));assert.deepEqual(calls,[]);
 const data=await bound.read(history.leadId,signal());assert.deepEqual(calls,[history.leadId]);assert.notEqual(data,original);assert.notEqual(data.history,original.history);
});
test('identity, organization, workspace, mode and lead mismatches are denied',async()=>{
 for(const r of [ {...response(),identityKey:'other'}, {...response(),scope:{...scope,organizationId:'other'}}, {...response(),scope:{...scope,workspaceId:'other'}}, {...response(),scope:{...scope,mode:'commercial' as const}}, {...response(),leadId:'other'}, {...response(),history:{...history,leadId:'other'}} ]){
  const bound=bindLeadLinkClient({async read(){return r;}},grant(),gate(),()=>now);await assert.rejects(()=>bound.read(history.leadId,signal()));
 }
});
test('unsafe or additional API fields are rejected rather than displayed',async()=>{
 const raw={...response(),originalUrl:'https://example.invalid/PRIVATE_SECRET'};
 const bound=bindLeadLinkClient({async read(){return raw;}},grant(),gate(),()=>now);await assert.rejects(()=>bound.read(history.leadId,signal()));
});
test('cancelled or superseded reads cannot restore private data even if the adapter ignores abort',async()=>{
 let resolve!:(r:LeadLinkResponse)=>void;let seen!:AbortSignal;const accessGate=new LeadLinkReadGate();const life=accessGate.start();
 const client:LeadLinkClient={read(_id,s){seen=s;return new Promise(done=>{resolve=done;});}};
 const bound=bindLeadLinkClient(client,grant(),life,()=>now);const promise=bound.read(history.leadId,signal());
 accessGate.cancel();assert.equal(seen.aborted,true);resolve(response());await assert.rejects(promise);
});
test('per-read cancellation and access expiry are checked after awaiting the transport',async()=>{
 for(const expire of [false,true]){
  let at=now,resolve!:(r:LeadLinkResponse)=>void;const controller=new AbortController();
  const bound=bindLeadLinkClient({read(){return new Promise(done=>{resolve=done;});}},grant(),gate(),()=>at);
  const pending=bound.read(history.leadId,controller.signal);if(expire)at=now+60_000;else controller.abort();
  resolve(response());await assert.rejects(pending);
 }
});
test('generation isolation makes the older lead selection permanently stale',()=>{
 const g=new LeadLinkReadGate();const first=g.start(),second=g.start();assert.equal(first.current(),false);assert.equal(first.signal.aborted,true);assert.equal(second.current(),true);g.cancel();assert.equal(second.current(),false);
});

test('identity and tenant limits match the authenticated HTTP response contract',()=>{
 const input=grant();input.identityKey='i'.repeat(256);input.scope.organizationId='o'.repeat(128);input.scope.workspaceId='w'.repeat(128);
 assert.equal(validateLeadLinkAccess(input,now).state,'ready');
 for(const invalid of [{...input,identityKey:'i'.repeat(257)},{...input,scope:{...input.scope,organizationId:'o'.repeat(129)}}])assert.throws(()=>validateLeadLinkAccess(invalid,now));
});
test('untrusted accessors and sparse ID grants are rejected without invocation',()=>{
 let calls=0;const raw={...grant()};Object.defineProperty(raw,'identityKey',{enumerable:true,get(){calls++;return 'key';}});
 assert.throws(()=>validateLeadLinkAccess(raw,now));assert.equal(calls,0);
 assert.throws(()=>validateLeadLinkAccess({...grant(),leadIds:new Array(1)},now));
});

test('read grant alone cannot expose opening tokens or metadata from a stronger server response',async()=>{
 const raw={...response(),history,openingSession:{canOpen:true,csrfToken:'synthetic_csrf_permission_test',expiresAtMs:now+60_000}};
 const bound=bindLeadLinkClient({async read(){return raw;}},grant(),gate(),()=>now);
 const value=await bound.read(history.leadId,signal());assert.equal(value.openingSession.canOpen,false);assert.equal(value.openingSession.csrfToken,null);assert.ok(value.history.links.every(link=>link.opening===null));
});
test('explicit opening grant keeps only server-authorized opaque references and bounded expiry',async()=>{
 const raw={...response(),history,openingSession:{canOpen:true,csrfToken:'synthetic_csrf_permission_test',expiresAtMs:now+120_000}};
 const bound=bindLeadLinkClient({async read(){return raw;}},{...grant(),canOpen:true},gate(),()=>now);
 const value=await bound.read(history.leadId,signal());assert.equal(value.openingSession.canOpen,true);assert.equal(value.openingSession.expiresAtMs,now+60_000);assert.ok(value.history.links.some(link=>link.opening!==null));
});
