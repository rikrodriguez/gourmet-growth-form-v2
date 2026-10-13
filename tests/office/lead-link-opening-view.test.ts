import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOpenableLeadLinks } from '../../src/office/backend/lead-link-opening-view';
import { demoOpeningScope, demoOpeningRecords, demoOpeningDestinations } from '../../src/office/backend/lead-link-demo-fixtures';
const lead={leadId:'demo-history-a',accountId:'demo-account',boardId:'200',itemId:'300'};
const project=(records=demoOpeningRecords,scope=demoOpeningScope)=>projectOpenableLeadLinks(scope,lead,records,new Map(),demoOpeningDestinations);
test('opening metadata is available only for reviewed exact destinations and eligible observations',()=>{
 const view=project();assert.equal(view.links.filter(l=>l.opening!==null).length,4);
 assert.ok(view.links.filter(l=>['missing','quarantined'].includes(l.status)||['landing_attribution','update_link'].includes(l.category)).every(l=>l.opening===null));
 assert.doesNotMatch(JSON.stringify(view),/https:\/\/|PRIVATE_|SYNTHETIC_SIGNATURE|sourceUrl|sessionId/);
});
test('tenant, internal lead and full source binding all isolate records before projection',()=>{
 for(const changed of [{...demoOpeningScope,organizationId:'other'},{...demoOpeningScope,workspaceId:'other'},{...demoOpeningScope,mode:'commercial' as const}])assert.equal(projectOpenableLeadLinks(changed,lead,demoOpeningRecords,new Map(),demoOpeningDestinations).links.length,0);
 for(const record of [{...demoOpeningRecords[0],leadId:'other'},{...demoOpeningRecords[0],sourceBinding:{...demoOpeningRecords[0].sourceBinding,itemId:'other'}}])assert.equal(project([record]).links.length,0);
});
test('duplicate opaque references and absent quote path approval never offer an ambiguous opening',()=>{
 const original=demoOpeningRecords[0];const dup=project([original,{...original,revision:'changed'}]);assert.ok(dup.links.every(l=>l.opening===null));
 const view=projectOpenableLeadLinks(demoOpeningScope,lead,demoOpeningRecords,new Map(),demoOpeningDestinations.filter(d=>d.category!=='quote'));
 assert.equal(view.links.find(l=>l.category==='quote')!.opening,null);
});
