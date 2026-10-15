import type { PoolClient } from 'pg';
import { EventQuoteError, type EventQuoteService, type EventQuoteView, type QuoteActor, type QuoteScope, type PaymentConfigurationV2 } from './event-quote-contracts';
import { canonical, digest } from './event-quote-workflow';
import { prepareGourmetPaymentsV2Wire } from './gourmet-payments-v2-wire';
import { createPaymentAgreementOperationV2, decodePaymentAgreementReceiptV2, paymentAgreementOperationIdV2,
  type PaymentAgreementAuthorizationV2, type PaymentAgreementIntegrationV2, type PaymentAgreementOperationCommandV2,
  type PaymentAgreementOperationV2, type PaymentAgreementReceiptV2 } from './payment-agreement-operations-v2';

export type PaymentAgreementAuthorizedContextV2 = { scope:QuoteScope; actor:QuoteActor; service:EventQuoteService; client:PoolClient };
export type AuthorizePaymentAgreementV2 = <T>(operation:(context:PaymentAgreementAuthorizedContextV2)=>Promise<T>)=>Promise<T>;
const fail=(code:string,status=422):never=>{throw new EventQuoteError(code,status);};
export function parsePaymentAgreementCommandV2(raw:unknown):PaymentAgreementOperationCommandV2 {
  const keys=['key','configurationId','configurationDigest','expectedReviewDigest','operation'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||!keys.every(k=>Object.hasOwn(raw,k)))return fail('INVALID_INPUT',400);
  const r=raw as Record<string,unknown>;
  if(![r.key,r.configurationId].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v))
    ||![r.configurationDigest,r.expectedReviewDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!['create','reconcile'].includes(r.operation as string))return fail('INVALID_INPUT',400);
  return structuredClone(r) as PaymentAgreementOperationCommandV2;
}
function enabled(context:PaymentAgreementAuthorizedContextV2,now:number) {
  if(context.scope.mode!=='test'||!context.actor.durable)return fail('PAYMENT_AGREEMENTS_TEST_ONLY',403);
  if(!context.actor.canWrite||!context.actor.canApprove||context.actor.expiresAtMs<=now)return fail('APPROVAL_FORBIDDEN',403);
  if(!Number.isSafeInteger(now)||now<0)return fail('INVALID_NOW',503);
}
function config(view:EventQuoteView,command:PaymentAgreementOperationCommandV2):PaymentConfigurationV2 {
  const c=view.record.paymentConfigurationsV2?.find(c=>c.id===command.configurationId);
  if(!c||c.digest!==command.configurationDigest||c.reviewDigest!==command.expectedReviewDigest)return fail('STALE_PAYMENT_CONFIGURATION',409);
  return c;
}
export async function freshOperation(context:PaymentAgreementAuthorizedContextV2,eventId:string,command:PaymentAgreementOperationCommandV2,integration:PaymentAgreementIntegrationV2,clock:()=>number):Promise<{operation:PaymentAgreementOperationV2;authorization:PaymentAgreementAuthorizationV2}> {
  enabled(context,clock());const view=await context.service.read(context.scope,context.actor,eventId),c=config(view,command);enabled(context,clock());
  const source=await integration.resolveSource(structuredClone(context.scope),eventId,structuredClone(view.record));
  enabled(context,clock());
  const status=await context.service.status(context.scope,context.actor),now=clock();enabled(context,now);
  if(!status.enabled||!status.catalog||status.catalog.authority!=='test_only'||!status.catalogDigest||status.catalog.validUntilMs<=now||!source||source.source!=='synthetic_fixture'
    ||c.leadSource!=='synthetic_fixture'||source.canonicalLeadId!==c.configuration.canonicalLeadId)return fail('PAYMENT_AGREEMENT_SOURCE_INVALID');
  const wire=prepareGourmetPaymentsV2Wire({scope:context.scope,eventId,record:view.record,preparationId:c.preparationId,configuration:c.configuration,currentCatalogDigest:status.catalogDigest,nowMs:now},
    {actor:context.actor,expectedReviewDigest:c.reviewDigest});
  if(wire.status==='blocked')return fail(wire.code,409);
  const q=view.record.quotes.find(q=>q.digest===wire.prepared.plan.sourceQuote.digest),b=view.record.briefs.find(b=>b.version===q?.briefVersion&&b.digest===q.briefDigest);
  if(!b||b.recipient!==wire.prepared.plan.sourceQuote.intendedRecipient)return fail('PAYMENT_AGREEMENT_SOURCE_INVALID');
  const operation=createPaymentAgreementOperationV2({prepared:wire.prepared,configurationId:c.id,configurationDigest:c.digest,recipientName:b.contactName,source});
  return {operation,authorization:{issuer:'gourmet_office',purpose:'create_disabled_payment_agreement_v2',actorId:context.actor.actorId,scope:structuredClone(context.scope),
    operationId:operation.operationId,operationDigest:digest(operation),issuedAtMs:now,expiresAtMs:Math.min(now+300_000,context.actor.expiresAtMs,status.catalog.validUntilMs)}};
}
async function bounded<T>(timeout:number,fn:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const control=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const deadline=performance.now()+timeout;
  try {const value=await Promise.race([fn(control.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new EventQuoteError('PAYMENT_AGREEMENT_DELIVERY_TIMEOUT',503));control.abort();},timeout);})]);
    if(performance.now()>=deadline){control.abort();return fail('PAYMENT_AGREEMENT_DELIVERY_TIMEOUT',503);}return value;
  } finally {if(timer)clearTimeout(timer);control.abort();}
}
/** This coordinator deliberately commits intent before transport and persists
 * remote outcomes independently. An Office authorization rollback cannot undo
 * a remote Payments commit. All retries look up the stable remote operation. */
export async function executePaymentAgreementOperationV2(eventId:string,raw:unknown,deps:{integration:PaymentAgreementIntegrationV2;authorize:AuthorizePaymentAgreementV2;clock?:()=>number}):Promise<EventQuoteView> {
  const command=parsePaymentAgreementCommandV2(raw),{integration,authorize}=deps,sourceClock=deps.clock??Date.now;
  let lastObserved=-1;
  const clock=()=>{const now=sourceClock();if(!Number.isSafeInteger(now)||now<0||now<lastObserved)return fail('PAYMENT_AGREEMENT_CLOCK_INVALID',503);lastObserved=now;return now;};
  const timeout=integration.deliveryTimeoutMs??2000;
  if(!Number.isFinite(timeout)||timeout<=0||timeout>5000)return fail('PAYMENT_AGREEMENT_TIMEOUT_INVALID',503);
  const committed=await authorize(async context=>{
    enabled(context,clock());const view=await context.service.read(context.scope,context.actor,eventId),c=config(view,command);
    const id=paymentAgreementOperationIdV2(context.scope,eventId,c.id,c.digest,c.preparationDigest);
    const prior=await integration.outbox.get(context.scope,eventId,id,context.client);
    const operation=prior?.operation??(command.operation==='reconcile'?fail('PAYMENT_AGREEMENT_NOT_FOUND',404):(await freshOperation(context,eventId,command,integration,clock)).operation);
    const handoff=await integration.outbox.putIntent({scope:context.scope,eventId,operation,actorId:context.actor.actorId,key:command.key,inputDigest:digest(command),atMs:clock()},context.client);
    return {scope:structuredClone(context.scope),operation:handoff.operation};
  });
  const claimed=await integration.outbox.claim(committed.scope,eventId,committed.operation.operationId,clock());
  if(claimed.attemptId) {
    let receipt:PaymentAgreementReceiptV2|null=null,rejected=false;
    try {
      const found=await bounded(timeout,signal=>integration.transport.reconcile(committed.operation.operationId,digest(committed.operation),signal));
      if(found.status===200)receipt=decodePaymentAgreementReceiptV2(found.body,committed.operation);
      else if(found.status===404&&command.operation==='create') {
        // Re-authorize after read-only lookup, under current ACL and current source.
        // The saved Prepared stays stable even when another authorized actor retries.
        const authorization=await authorize(async context=>{
          const checked=await freshOperation(context,eventId,command,integration,clock);
          const actual=committed.operation;
          // Approval actor/time are historical evidence, so compare source plan and
          // recipient/service facts separately from the newly issued local snapshot.
          if(canonical(checked.operation.prepared.plan)!==canonical(actual.prepared.plan)||checked.operation.prepared.reviewDigest!==actual.prepared.reviewDigest
            ||canonical(checked.operation.recipient)!==canonical(actual.recipient)||canonical(checked.operation.service)!==canonical(actual.service))return fail('PAYMENT_AGREEMENT_OPERATION_CONFLICT',409);
          return {...checked.authorization,operationId:actual.operationId,operationDigest:digest(actual)};
        });
        if(authorization.expiresAtMs<=clock())return fail('APPROVAL_FORBIDDEN',403);
        const created=await bounded(timeout,signal=>integration.transport.create(committed.operation,authorization,signal));
        if(created.status===200||created.status===201)receipt=decodePaymentAgreementReceiptV2(created.body,committed.operation);
        else if([400,422].includes(created.status))rejected=true;
        // 409 can mean the same original idempotency operation is still in
        // progress/ambiguous. It must remain recoverable through reconciliation.
      }
    } catch { /* Ambiguous transport/expired authority stays durable for lookup. */ }
    await integration.outbox.finish(committed.scope,eventId,committed.operation.operationId,claimed.attemptId,{receipt,rejected},clock());
  }
  // Never return private bytes under an authorization that expired during I/O.
  return authorize(async context=>{enabled(context,clock());if(canonical(context.scope)!==canonical(committed.scope))return fail('ACCESS_DENIED',403);const view=await context.service.read(context.scope,context.actor,eventId);return {...view,paymentAgreementOperationsV2:await integration.outbox.list(context.scope,eventId,context.client)};});
}
