import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { EventQuoteError, type QuoteScope } from './event-quote-contracts';
import { canonical, digest } from './event-quote-workflow';
import { eventQuoteStorageKey } from './event-quote-postgres';
import type { MondayVault } from './monday-store';
import { decodePaymentAgreementReceiptV2, paymentAgreementOperationIdV2, type PaymentAgreementHandoffV2, type PaymentAgreementOutboxV2, type PaymentAgreementOperationSummaryV2, type PaymentAgreementReceiptV2 } from './payment-agreement-operations-v2';
import { prepareGourmetCheckoutConditionsV1 } from './gourmet-checkout-conditions-v1';
import { checkoutIssuanceIdV1, decodeGourmetCheckoutEmissionReceiptV1, type CheckoutEmissionReceiptV1 } from './gourmet-checkout-emission-v1';

const unavailable = () => new EventQuoteError('PAYMENT_AGREEMENT_OUTBOX_UNAVAILABLE', 503);
const invalid = () => new EventQuoteError('PAYMENT_AGREEMENT_OUTBOX_INVALID', 503);
type Row = { operation_id: string; revision: number; payload: unknown; audit: unknown };
const binding = (eventKey: string, operationId: string, revision: number) => `gourmet-payment-handoff:v2:${eventKey}:${operationId}:${revision}`;
/** Caller-owned PostgreSQL and vault. This repository never dispatches a request
 * or initializes a schema during normal startup. Handoff intents use the caller's
 * existing authorization transaction; delivery attempts use short independent transactions. */
export class PostgresPaymentAgreementOutboxV2 implements PaymentAgreementOutboxV2 {
  private readonly schema: string;
  constructor(private readonly pool: Pool, private readonly options: { vault: Pick<MondayVault, 'seal' | 'open'>; schema?: string }) {
    this.schema = options.schema ?? 'gourmet_quotes';
    if (!/^(gourmet_quotes|quote_test_[a-f0-9]{32})$/.test(this.schema)) throw unavailable();
  }
  /** Explicit fresh loopback fixture provisioning only. No remote migrations. */
  async initialize(): Promise<void> {
    if (!/^quote_test_[a-f0-9]{32}$/.test(this.schema)) throw unavailable();
    let host: string | undefined;
    try { if (this.pool.options.connectionString) { const u = new URL(this.pool.options.connectionString); if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash) throw unavailable(); host = u.hostname; } else host = this.pool.options.host; } catch { throw unavailable(); }
    if (!host || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw unavailable();
    await this.transaction(async c => {
      const sql=(await readFile(new URL('../../../migrations/office/007_payment_agreement_handoffs.up.sql',import.meta.url),'utf8')).replaceAll('gourmet_quotes',this.schema);
      await c.query(sql);
    });
  }
  private sql(lock = false) { return `SELECT h.operation_id,h.revision,h.payload,COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',a.revision,'digest',a.digest,'previousDigest',a.previous_digest,'payloadDigest',a.payload_digest,'kind',a.kind,'atMs',a.at_ms) ORDER BY a.revision) FROM ${this.schema}.payment_handoff_events_v2 a WHERE a.event_key=h.event_key AND a.operation_id=h.operation_id),'[]'::jsonb) audit FROM ${this.schema}.payment_handoffs_v2 h WHERE h.event_key=$1 AND h.operation_id=$2${lock ? ' FOR UPDATE OF h' : ''}`; }
  private decode(scope: QuoteScope, eventId: string, row: Row): PaymentAgreementHandoffV2 {
    try {
      const key = eventQuoteStorageKey(scope, eventId), h = this.options.vault.open(row.payload, binding(key, row.operation_id, row.revision)) as PaymentAgreementHandoffV2;
      if (!h || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 100 || h.revision !== row.revision || h.operation.operationId !== row.operation_id
        || canonical(h.operation.prepared.plan.scope) !== canonical(scope) || h.operation.prepared.plan.eventId !== eventId || h.operationDigest !== digest(h.operation)
        || h.operation.operationId !== paymentAgreementOperationIdV2(scope, eventId, h.operation.configurationId, h.operation.configurationDigest, h.operation.prepared.plan.preparationDigest)
        || h.summary.operationId !== row.operation_id || h.summary.operationDigest !== h.operationDigest || h.summary.configurationId !== h.operation.configurationId
        || h.summary.configurationDigest !== h.operation.configurationDigest || !Number.isSafeInteger(h.summary.updatedAtMs) || h.summary.updatedAtMs < h.operation.prepared.internalApproval.atMs
        || h.summary.executable !== false || h.summary.providerEnabled !== false || h.summary.publicPaymentUrl !== null || h.summary.authorizationVerified !== false
        || !['pending', 'reconciliation_required', 'draft_persisted', 'rejected'].includes(h.summary.status)
        || (h.attemptId === null) !== (h.leaseUntilMs === null) || h.leaseUntilMs !== null && (!Number.isSafeInteger(h.leaseUntilMs) || h.summary.status !== 'reconciliation_required')) throw invalid();
      if (h.receipt) { decodePaymentAgreementReceiptV2(canonical(h.receipt), h.operation); if (h.summary.status !== 'draft_persisted' || h.summary.agreementId !== h.receipt.agreementId || h.summary.serviceAuthenticated !== true || h.attemptId !== null) throw invalid(); }
      else if (h.summary.status === 'draft_persisted' || h.summary.agreementId !== null || h.summary.serviceAuthenticated !== false) throw invalid();
      if (h.summary.checkout) {
        const checkout = h.summary.checkout;
        const conditions = this.checkoutConditions(h);
        const expectedId = checkoutIssuanceIdV1({ sourceDraftId: h.receipt!.agreementId, operationId: h.operation.operationId,
          operationDigest: h.operationDigest, conditionsDigest: conditions.conditionsDigest });
        if (checkout.issuanceId !== expectedId || checkout.conditionsDigest !== conditions.conditionsDigest
          || checkout.executable !== false || checkout.providerEnabled !== false || checkout.authorizationVerified !== false
          || !['pending', 'reconciliation_required', 'checkout_issued'].includes(checkout.status) || !h.checkoutOrigin) throw invalid();
        if (h.checkoutReceipt) {
          this.validateCheckoutReceipt(h, h.checkoutReceipt);
          if (checkout.status !== 'checkout_issued' || checkout.checkoutId !== h.checkoutReceipt.checkoutId
            || checkout.publicPaymentUrl !== h.checkoutReceipt.publicPaymentUrl || checkout.serviceAuthenticated !== true) throw invalid();
        } else if (checkout.status === 'checkout_issued' || checkout.checkoutId !== null || checkout.publicPaymentUrl !== null || checkout.serviceAuthenticated !== false) throw invalid();
      } else if (h.checkoutReceipt || h.checkoutOrigin) throw invalid();
      if (!Array.isArray(row.audit) || row.audit.length !== row.revision) throw invalid();
      let previousDigest: string | null = null;
      for (let i = 0; i < row.audit.length; i++) {
        const e = row.audit[i]; const { digest: saved, ...facts } = e;
        if (e.revision !== i + 1 || e.previousDigest !== previousDigest || saved !== digest(facts)) throw invalid();
        previousDigest = saved;
      }
      if (row.audit.at(-1).payloadDigest !== digest(h) || row.audit.at(-1).atMs !== h.summary.updatedAtMs) throw invalid();
      return h;
    } catch { throw invalid(); }
  }
  private async load(scope: QuoteScope, eventId: string, id: string, c: Pick<PoolClient, 'query'>, lock = false) {
    const key=eventQuoteStorageKey(scope,eventId);
    // Acquire the row lock in a separate statement. A waiting READ COMMITTED
    // SELECT may refresh its locked row while correlated audit subqueries still
    // use the earlier statement snapshot; reading after the lock avoids mixing revisions.
    if(lock)await c.query(`SELECT operation_id FROM ${this.schema}.payment_handoffs_v2 WHERE event_key=$1 AND operation_id=$2 FOR UPDATE`,[key,id]);
    const r = await c.query<Row>(this.sql(), [key, id]);
    if (r.rows.length > 1) throw invalid(); return r.rows.length ? this.decode(scope, eventId, r.rows[0]) : null;
  }
  async get(scope: QuoteScope, eventId: string, id: string, c?: PoolClient) { try { return await this.load(scope, eventId, id, c ?? this.pool); } catch (e) { throw safe(e); } }
  async list(scope: QuoteScope, eventId: string, c?: PoolClient): Promise<PaymentAgreementOperationSummaryV2[]> {
    try { const db = c ?? this.pool, r = await db.query<{ operation_id: string }>(`SELECT operation_id FROM ${this.schema}.payment_handoffs_v2 WHERE event_key=$1 ORDER BY operation_id`, [eventQuoteStorageKey(scope, eventId)]);
      if (r.rows.length > 20) throw invalid(); const list = []; for (const row of r.rows) {
        const handoff = (await this.load(scope, eventId, row.operation_id, db))!;
        list.push({ ...handoff.summary, ...(handoff.receipt ? { checkoutConditionsDigest: this.checkoutConditions(handoff).conditionsDigest } : {}) });
      } return list;
    } catch (e) { throw safe(e); }
  }
  private async save(scope: QuoteScope, eventId: string, h: PaymentAgreementHandoffV2, kind: string, c: PoolClient, prior: number) {
    const key = eventQuoteStorageKey(scope, eventId), id = h.operation.operationId;
    if (h.revision !== prior + 1 || h.revision > 100 || Buffer.byteLength(canonical(h)) > 512 * 1024) throw invalid();
    const sealed = JSON.stringify(this.options.vault.seal(h, binding(key, id, h.revision)));
    if (!prior) await c.query(`INSERT INTO ${this.schema}.payment_handoffs_v2 VALUES($1,$2,$3,$4::jsonb)`, [key, id, h.revision, sealed]);
    else { const r = await c.query(`UPDATE ${this.schema}.payment_handoffs_v2 SET revision=$3,payload=$4::jsonb WHERE event_key=$1 AND operation_id=$2 AND revision=$5`, [key,id,h.revision,sealed,prior]); if (r.rowCount !== 1) throw invalid(); }
    const prev = prior ? (await c.query<{ digest: string }>(`SELECT digest FROM ${this.schema}.payment_handoff_events_v2 WHERE event_key=$1 AND operation_id=$2 AND revision=$3`, [key,id,prior])).rows[0]?.digest : null;
    if (prior && !prev) throw invalid();
    const facts = { revision:h.revision,previousDigest:prev,payloadDigest:digest(h),kind,atMs:h.summary.updatedAtMs };
    await c.query(`INSERT INTO ${this.schema}.payment_handoff_events_v2 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [key,id,h.revision,digest(facts),prev,facts.payloadDigest,kind,facts.atMs]);
  }
  async putIntent(input: Parameters<PaymentAgreementOutboxV2['putIntent']>[0], c: PoolClient): Promise<PaymentAgreementHandoffV2> {
    try {
      const { scope,eventId,operation,actorId,key,inputDigest,atMs } = input, eventKey = eventQuoteStorageKey(scope,eventId);
      await c.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [47001907,eventKey]);
      const commandDigest=digest({key}),actorDigest=digest({actorId});
      const command = (await c.query<{actor_digest:string;input_digest:string;operation_id:string}>(`SELECT actor_digest,input_digest,operation_id FROM ${this.schema}.payment_handoff_commands_v2 WHERE event_key=$1 AND command_digest=$2`, [eventKey,commandDigest])).rows[0];
      if (command && (command.actor_digest !== actorDigest || command.input_digest !== inputDigest || command.operation_id !== operation.operationId)) throw new EventQuoteError('IDEMPOTENCY_CONFLICT',409);
      let h = await this.load(scope,eventId,operation.operationId,c,true);
      if (h && canonical(h.operation) !== canonical(operation)) throw new EventQuoteError('PAYMENT_AGREEMENT_OPERATION_CONFLICT',409);
      if (!h) {
        const n = await c.query<{count:string}>(`SELECT count(*) FROM ${this.schema}.payment_handoffs_v2 WHERE event_key=$1`,[eventKey]); if (Number(n.rows[0].count) >= 20) throw invalid();
        const opDigest = digest(operation);
        h = { operation: structuredClone(operation),operationDigest:opDigest,revision:1,receipt:null,attemptId:null,leaseUntilMs:null,
          summary:{operationId:operation.operationId,operationDigest:opDigest,configurationId:operation.configurationId,configurationDigest:operation.configurationDigest,status:'pending',agreementId:null,executable:false,providerEnabled:false,publicPaymentUrl:null,authorizationVerified:false,serviceAuthenticated:false,updatedAtMs:atMs} };
        await this.save(scope,eventId,h,'intent_committed',c,0);
      }
      if (!command) await c.query(`INSERT INTO ${this.schema}.payment_handoff_commands_v2 VALUES($1,$2,$3,$4,$5)`,[eventKey,commandDigest,actorDigest,inputDigest,operation.operationId]);
      return h;
    } catch(e) { throw safe(e); }
  }
  private async transaction<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T> { let c:PoolClient|undefined; try { c=await this.pool.connect(); await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'"); const value=await fn(c); await c.query('COMMIT'); return value; } catch(e) { if(c)try{await c.query('ROLLBACK');}catch{} throw safe(e); } finally { c?.release(); } }
  async claim(scope:QuoteScope,eventId:string,id:string,now:number) {
    return this.transaction(async c=> { const h=await this.load(scope,eventId,id,c,true); if(!h)throw invalid();
      if(!Number.isSafeInteger(now)||now<h.summary.updatedAtMs)throw invalid();
      if(h.summary.status==='draft_persisted'||h.summary.status==='rejected'||h.leaseUntilMs!==null&&h.leaseUntilMs>now)return{handoff:h,attemptId:null};
      const prior=h.revision; h.revision++;h.attemptId=randomUUID();h.leaseUntilMs=now+30_000;h.summary.status='reconciliation_required';h.summary.updatedAtMs=now;
      await this.save(scope,eventId,h,'delivery_claimed',c,prior);return{handoff:h,attemptId:h.attemptId}; });
  }
  async finish(scope:QuoteScope,eventId:string,id:string,attemptId:string,result:{receipt:PaymentAgreementReceiptV2|null;rejected?:boolean},now:number) {
    await this.transaction(async c=> { const h=await this.load(scope,eventId,id,c,true);if(!h)throw invalid();
      if(h.attemptId!==attemptId)return; // A late response cannot overwrite a newer attempt.
      if(!Number.isSafeInteger(now)||now<h.summary.updatedAtMs)throw invalid(); const prior=h.revision;h.revision++;h.attemptId=null;h.leaseUntilMs=null;h.summary.updatedAtMs=now;
      if(result.receipt){h.receipt=decodePaymentAgreementReceiptV2(canonical(result.receipt),h.operation);h.summary.status='draft_persisted';h.summary.agreementId=h.receipt.agreementId;h.summary.serviceAuthenticated=true;}
      else h.summary.status=result.rejected?'rejected':'reconciliation_required';
      await this.save(scope,eventId,h,h.receipt?'receipt_reconciled':result.rejected?'delivery_rejected':'delivery_ambiguous',c,prior); });
  }
  private checkoutConditions(h: PaymentAgreementHandoffV2) {
    if (!h.receipt || h.summary.status !== 'draft_persisted') throw invalid();
    const result = prepareGourmetCheckoutConditionsV1({ receipt: h.receipt, nowMs: h.operation.prepared.internalApproval.atMs });
    if (result.status === 'blocked') throw invalid();
    return result;
  }
  private validateCheckoutReceipt(h: PaymentAgreementHandoffV2, receipt: CheckoutEmissionReceiptV1) {
    const conditions = this.checkoutConditions(h);
    if (!h.summary.checkout || !h.checkoutOrigin) throw invalid();
    return decodeGourmetCheckoutEmissionReceiptV1(canonical(receipt), {
      command: { issuanceId: h.summary.checkout.issuanceId, sourceDraftId: h.receipt!.agreementId,
        conditionsDigest: conditions.conditionsDigest } as Parameters<typeof decodeGourmetCheckoutEmissionReceiptV1>[1]['command'],
      conditions: conditions.conditions, providerAssessment: conditions.providerAssessment, publicCheckoutOrigin: h.checkoutOrigin,
    });
  }
  async putCheckoutIntent(input: Parameters<NonNullable<PaymentAgreementOutboxV2['putCheckoutIntent']>>[0], client: PoolClient): Promise<void> {
    try {
      const { scope, eventId, operationId, atMs } = input, eventKey = eventQuoteStorageKey(scope, eventId);
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [47001907, eventKey]);
      const h = await this.load(scope, eventId, operationId, client, true);
      if (!h || !Number.isSafeInteger(atMs) || atMs < h.summary.updatedAtMs) throw invalid();
      const conditions = this.checkoutConditions(h);
      const expectedId = checkoutIssuanceIdV1({ sourceDraftId: h.receipt!.agreementId, operationId, operationDigest: h.operationDigest,
        conditionsDigest: conditions.conditionsDigest });
      if (input.issuanceId !== expectedId || input.conditionsDigest !== conditions.conditionsDigest) throw invalid();
      const origin = new URL(input.publicCheckoutOrigin);
      if (origin.origin !== input.publicCheckoutOrigin || origin.username || origin.password
        || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw invalid();
      const commandDigest = digest({ key: input.key }), actorDigest = digest({ actorId: input.actorId });
      const priorCommand = (await client.query<{actor_digest:string;input_digest:string;operation_id:string}>(
        `SELECT actor_digest,input_digest,operation_id FROM ${this.schema}.payment_handoff_commands_v2 WHERE event_key=$1 AND command_digest=$2`, [eventKey, commandDigest])).rows[0];
      if (priorCommand && (priorCommand.actor_digest !== actorDigest || priorCommand.input_digest !== input.inputDigest || priorCommand.operation_id !== operationId))
        throw new EventQuoteError('IDEMPOTENCY_CONFLICT', 409);
      if (h.summary.checkout && (h.summary.checkout.issuanceId !== input.issuanceId || h.checkoutOrigin !== input.publicCheckoutOrigin)) throw invalid();
      if (!h.summary.checkout) {
        const prior = h.revision; h.revision++; h.summary.updatedAtMs = atMs; h.checkoutOrigin = input.publicCheckoutOrigin;
        h.summary.checkout = { issuanceId: input.issuanceId, conditionsDigest: input.conditionsDigest, status: 'pending', checkoutId: null,
          publicPaymentUrl: null, executable: false, providerEnabled: false, authorizationVerified: false, serviceAuthenticated: false };
        await this.save(scope, eventId, h, 'intent_committed', client, prior);
      }
      if (!priorCommand) await client.query(`INSERT INTO ${this.schema}.payment_handoff_commands_v2 VALUES($1,$2,$3,$4,$5)`,
        [eventKey, commandDigest, actorDigest, input.inputDigest, operationId]);
    } catch (error) { throw safe(error); }
  }
  async finishCheckout(scope: QuoteScope, eventId: string, operationId: string, issuanceId: string, receipt: CheckoutEmissionReceiptV1 | null, nowMs: number): Promise<void> {
    await this.transaction(async client => {
      const h = await this.load(scope, eventId, operationId, client, true);
      if (!h || !h.summary.checkout || h.summary.checkout.issuanceId !== issuanceId || !Number.isSafeInteger(nowMs) || nowMs < h.summary.updatedAtMs) throw invalid();
      if (h.checkoutReceipt) {
        if (receipt && canonical(receipt) !== canonical(h.checkoutReceipt)) throw invalid();
        return;
      }
      const prior = h.revision; h.revision++; h.summary.updatedAtMs = nowMs;
      if (receipt) {
        h.checkoutReceipt = this.validateCheckoutReceipt(h, receipt);
        h.summary.checkout = { ...h.summary.checkout, status: 'checkout_issued', checkoutId: receipt.checkoutId,
          publicPaymentUrl: receipt.publicPaymentUrl, serviceAuthenticated: true };
      } else h.summary.checkout.status = 'reconciliation_required';
      await this.save(scope, eventId, h, receipt ? 'receipt_reconciled' : 'delivery_ambiguous', client, prior);
    });
  }
}
function safe(error:unknown):EventQuoteError { return error instanceof EventQuoteError ? error : unavailable(); }
