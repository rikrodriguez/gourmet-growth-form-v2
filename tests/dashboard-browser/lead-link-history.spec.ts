import { test, expect, type Page } from '@playwright/test';
import Fastify from 'fastify';
async function open(page:Page, origin=''){await page.goto(`${origin}/office/lead-link-history-demo.html#events`);await expect(page.getByTestId('dashboard-lead-history')).toBeVisible();}
async function verify(page:Page){await page.getByRole('button',{name:'Verificar acceso al historial',exact:true}).click();await expect(page.getByLabel('Lead autorizado',{exact:true})).toBeVisible();}
async function select(page:Page,id='demo-history-a'){await page.getByLabel('Lead autorizado',{exact:true}).selectOption(id);}
async function read(page:Page){await page.getByRole('button',{name:'Consultar historial del lead',exact:true}).click();}
const panel=(page:Page)=>page.getByRole('region',{name:'Enlaces históricos del lead',exact:true});
test('mounted history starts closed, preserves source snapshots and approved agreement independently',async({page},testInfo)=>{
 const external:string[]=[];page.on('request',request=>{const u=new URL(request.url());if(!['127.0.0.1','localhost'].includes(u.hostname))external.push(u.origin);});
 await open(page);await expect(panel(page)).toHaveCount(0);await verify(page);await select(page);await expect(panel(page)).toHaveCount(0);await read(page);
 await expect(panel(page)).toContainText('45 invitados');await expect(panel(page)).toContainText('Consulta conservada en enlace: 50 invitados');await expect(panel(page)).toContainText('Consulta conservada en enlace: 60 invitados');
 await expect(panel(page)).toContainText('Identificador de clic Google');await expect(panel(page)).toContainText('visita y conversión sin verificar');
 await expect(panel(page).locator('a,iframe,img,script')).toHaveCount(0);await expect(panel(page)).not.toContainText('PRIVATE_');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.evaluate(()=>{window.scrollTo(0,0);const sidebar=document.querySelector('.ga-sidebar');if(sidebar)sidebar.scrollTop=0;});
 await page.screenshot({path:`test-results/dashboard-visual/${testInfo.project.name}-lead-history.png`,fullPage:true});expect(external).toEqual([]);
});
test('changing leads discards data, requires a fresh read and suppresses an old late response',async({page})=>{
 await open(page);await verify(page);await select(page);await page.getByRole('button',{name:'Demorar próxima consulta sintética'}).click();await read(page);await select(page,'demo-history-b');
 await page.waitForTimeout(800);await expect(panel(page)).toHaveCount(0);await read(page);await expect(panel(page)).toContainText('80 invitados');await expect(panel(page)).not.toContainText('45 invitados');
 await select(page);await expect(panel(page)).toHaveCount(0);await select(page,'demo-history-b');await expect(panel(page)).toHaveCount(0);
});
test('withdrawal closes immediately, late responses stay closed and restored identity needs verification',async({page})=>{
 await open(page);await verify(page);await select(page);await page.getByRole('button',{name:'Demorar próxima consulta sintética'}).click();await read(page);
 await page.getByRole('button',{name:'Retirar identidad sintética'}).click();await page.waitForTimeout(800);await expect(panel(page)).toHaveCount(0);await expect(page.getByLabel('Lead autorizado',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Restablecer identidad sintética'}).click();await expect(page.getByLabel('Lead autorizado',{exact:true})).toHaveCount(0);await verify(page);await expect(panel(page)).toHaveCount(0);
});
test('close, DEMO navigation, Back and reload never reopen historical records',async({page})=>{
 await open(page);await verify(page);await select(page);await read(page);await expect(panel(page)).toBeVisible();await page.getByRole('button',{name:'Cerrar historial',exact:true}).click();await expect(panel(page)).toHaveCount(0);
 await verify(page);await select(page);await read(page);await expect(panel(page)).toBeVisible();await page.getByTestId('dashboard-quotes-demo').click();await expect(page.getByTestId('dashboard-lead-history')).toHaveCount(0);
 await page.goBack();await expect(page.getByTestId('dashboard-lead-history')).toBeVisible();await expect(panel(page)).toHaveCount(0);await expect(page.getByLabel('Lead autorizado',{exact:true})).toHaveCount(0);
 await verify(page);await select(page);await read(page);await expect(panel(page)).toBeVisible();await page.reload();await expect(panel(page)).toHaveCount(0);
});

// Native form -> loopback HTTP handler -> test-only Location boundary -> second loopback origin.
// Keep production authorization/303 unchanged; verify exact Location before replacing only its origin.
// A redirect cannot rely on a second Playwright interception to prevent provider contact.
import { createLeadLinkOpenApi, LEAD_LINK_OPEN_API, type LeadLinkOpenIdentity } from '../../src/office/backend/lead-link-opening';
import { demoOpeningRecords, demoOpeningScope, demoOpeningDestinations } from '../../src/office/backend/lead-link-demo-fixtures';
test('explicit open uses native POST, exact server Location, isolated redirect and no referrer/opener',async({page,context})=>{
 const origin='http://127.0.0.1:4182';
 const viteOrigin='http://127.0.0.1:4175';
 const destinationOrigin='http://127.0.0.1:4183';
 const destinationApp=Fastify({logger:false});
 const identity:LeadLinkOpenIdentity={identityKey:'synthetic-test-identity',durableIdentity:false,scope:demoOpeningScope,expiresAtMs:Date.now()+600000,canRead:true,canOpen:true,csrfToken:'synthetic_open_csrf_fixture_not_credential',leadIds:['demo-history-a','demo-history-b']};
 const app=createLeadLinkOpenApi({allowedOrigin:origin,allowedDestinations:demoOpeningDestinations,resolveIdentity:()=>identity,
  source:{async read(scope,leadId,referenceId){return demoOpeningRecords.find(record=>record.scope.organizationId===scope.organizationId&&record.scope.workspaceId===scope.workspaceId&&record.scope.mode===scope.mode&&record.leadId===leadId&&record.referenceId===referenceId)??null;}}});
 const opens:{method:string;data:string|null}[]=[];
 const responses:{status:number;site:unknown;mode:unknown;destination:unknown;user:unknown;origin:'expected'|'null'|'other'|'missing'}[]=[];
 app.addHook('onResponse',async(request,reply)=>{if(request.url===LEAD_LINK_OPEN_API)responses.push({status:reply.statusCode,site:request.headers['sec-fetch-site'],mode:request.headers['sec-fetch-mode'],destination:request.headers['sec-fetch-dest'],user:request.headers['sec-fetch-user'],origin:request.headers.origin===origin?'expected':request.headers.origin==='null'?'null':request.headers.origin?'other':'missing'});});
 // Only the synthetic page/assets are served through the local Vite process. No provider proxy exists.
 app.get('/*',async(request,reply)=>{const response=await fetch(viteOrigin+request.url,{redirect:'manual'});reply.code(response.status).type(response.headers.get('content-type')??'application/octet-stream');return reply.send(Buffer.from(await response.arrayBuffer()));});
 const destinations:{url:string;method:string;data:unknown;headers:Record<string,unknown>}[]=[];
 const originalLocations:string[]=[];const unexpected:string[]=[];
 // Test-only transport isolation, never installed in the application/runtime. The exact server
 // Location is asserted below; only its destination origin is replaced before any browser receives it.
 app.addHook('onSend',async(_request,reply,payload)=>{
  if(reply.statusCode===303){
   const original=String(reply.getHeader('Location'));originalLocations.push(original);
   const target=new URL(original);reply.header('Location',destinationOrigin+target.pathname+target.search);
  }
  return payload;
 });
 destinationApp.get('/*',async(request,reply)=>{
  destinations.push({url:destinationOrigin+request.url,method:request.method,data:request.body??null,headers:request.headers});
  return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
   .header('Content-Security-Policy',"default-src 'none'").type('text/html; charset=utf-8')
   .send('<!doctype html><meta charset="utf-8"><title>Destino sintético aislado</title><p>Prueba local. Ningún proveedor fue contactado.</p>');
 });
 context.on('request',request=>{
  const url=new URL(request.url());
  if(url.origin===origin && url.pathname===LEAD_LINK_OPEN_API)opens.push({method:request.method(),data:request.postData()});
  if(![origin,destinationOrigin].includes(url.origin))unexpected.push(url.origin);
 });
 await context.route('https://**',route=>route.abort());
 await context.routeWebSocket('**/*',socket=>socket.close()); // Hot reload is unnecessary in this isolated test.
 try{
  await destinationApp.listen({host:'127.0.0.1',port:4183});
  await app.listen({host:'127.0.0.1',port:4182});
  for(const name of ['Calculator','AI Notes','AI Closer','Quotes']){
   await open(page,origin);await verify(page);await select(page);await read(page);await expect(panel(page)).toBeVisible();
   const before=destinations.length;await page.waitForTimeout(100);expect(destinations).toHaveLength(before);
   const button=panel(page).getByRole('button',{name:`Abrir ${name}`,exact:true});
   const form=button.locator('..');await expect(form).toHaveAttribute('action',LEAD_LINK_OPEN_API);await expect(form).toHaveAttribute('method','post');await expect(form).toHaveAttribute('rel','noopener noreferrer');
   const [popup]=await Promise.all([context.waitForEvent('page'),name === 'AI Notes' ? button.press('Enter') : button.click()]);
   await expect.poll(()=>responses.length).toBe(before+1);
   expect(responses.at(-1),'Native POST must pass the unchanged server navigation and permission checks').toMatchObject({status:303,site:'same-origin',mode:'navigate',destination:'document',user:'?1'});
   await popup.waitForLoadState('domcontentloaded');await expect(popup).toHaveTitle('Destino sintético aislado');
   expect(await popup.evaluate(()=>window.opener===null)).toBe(true);
   const received=destinations.at(-1)!;expect(destinations).toHaveLength(before+1);expect(received.method).toBe('GET');expect(received.data).toBeNull();expect(received.headers.referer).toBeUndefined();
   expect(opens.at(-1)?.method).toBe('POST');expect(responses.at(-1)?.status).toBe(303);
   expect(opens.at(-1)?.data).not.toContain('https');
   const category=({Calculator:'calculator','AI Notes':'lead_notes','AI Closer':'sales_closer',Quotes:'quote'} as const)[name as 'Calculator'|'AI Notes'|'AI Closer'|'Quotes'];
   const original=demoOpeningRecords.find(record=>record.link.category===category&&record.link.status==='historical'&&record.link.outer)?.link.outer?.originalUrl;
   expect(originalLocations.at(-1)).toBe(original);
   expect(received.url).toBe(destinationOrigin+new URL(original!).pathname+new URL(original!).search);
   if(name==='Quotes')expect(received.url).toContain('signature=SYNTHETIC_SIGNATURE%2BKEEP%2FEXACT');
   await popup.close();
  }
  expect(unexpected).toEqual([]);
 }finally{await app.close();await destinationApp.close();}
});

test('FullURL, missing and quarantined references never gain open controls',async({page})=>{
 await open(page);await verify(page);await select(page);await read(page);
 const cards=panel(page).locator('li');
 await expect(cards.filter({has:page.getByRole('heading',{name:'FullURL · Página de origen',exact:true})}).getByRole('button')).toHaveCount(0);
 await expect(cards.filter({hasText:'Enlace no registrado'}).getByRole('button')).toHaveCount(0);
 await expect(cards.filter({hasText:'Pendiente de revisión de identidad o destino'}).getByRole('button')).toHaveCount(0);
});
