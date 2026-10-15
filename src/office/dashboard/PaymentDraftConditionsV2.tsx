import React, { useEffect, useState } from 'react';
import type { EventQuoteView, PaymentConfigurationFactsV2, PaymentConfigurationV2, PaymentContractPreparationV2, QuoteCommand } from '../backend/event-quote-contracts';
import { proposeRetainerBalanceDateV2, resolveApprovedLocalMinuteV2 } from '../backend/payment-calendar-v2';
import { exactPaymentConfigurationV2Command, exactPaymentDraftRegistrationV2Command, type EventQuoteStatusResponse } from '../event-quote-client';

const money = (cents: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'USD' }).format(cents / 100);
function cents(value: string): number | null {
  if (value.length > 18) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const result = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return result > 0n && result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
/** Existing card content only. Every field starts unconfigured; the server owns identity and lead resolution. */
export function PaymentConditionsFormV2({ view, status, preparation, enabled, onCommand }: {
  view: EventQuoteView; status: EventQuoteStatusResponse; preparation: PaymentContractPreparationV2; enabled: boolean; onCommand(command: QuoteCommand): void;
}) {
  const [paymentTerms, setPaymentTerms] = useState(''), [termsReason, setTermsReason] = useState('');
  const [eventDate, setEventDate] = useState(''), [eventTime, setEventTime] = useState(''), [timezone, setTimezone] = useState('');
  const [balanceDate, setBalanceDate] = useState(''), [balanceTime, setBalanceTime] = useState(''), [timingReason, setTimingReason] = useState('');
  const [agreedBalance, setAgreedBalance] = useState('');
  const [expiration, setExpiration] = useState<'' | 'never' | 'at'>(''), [expirationDate, setExpirationDate] = useState('');
  const [expirationTime, setExpirationTime] = useState(''), [expirationTimezone, setExpirationTimezone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mode = preparation.paymentMode;
  const proposal = mode === 'retainer_50' && eventDate && eventTime && timezone && resolveApprovedLocalMinuteV2(eventDate, eventTime, timezone)
    ? proposeRetainerBalanceDateV2({ eventDate, eventTime, timezone, nowMs: Date.now() }) : null;
  const reasonRequired = !preparation.quotedDepositMatchesMode || paymentTerms !== preparation.terms;
  const expectedBalance = mode === 'fixed_49_reservation' ? cents(agreedBalance) : null;
  const complete = paymentTerms.trim().length > 0 && (!reasonRequired || termsReason.trim().length > 0)
    && expiration !== '' && (expiration !== 'at' || !!expirationDate && !!expirationTime && !!expirationTimezone)
    && (mode === 'full_upfront' || !!balanceDate && !!balanceTime && !!timezone)
    && (mode !== 'retainer_50' || !!eventDate && !!eventTime)
    && (mode !== 'fixed_49_reservation' || expectedBalance === preparation.paymentBalanceCents);
  function save(event: React.FormEvent) {
    event.preventDefault(); if (!enabled || !complete) return;
    const facts: PaymentConfigurationFactsV2 = { paymentTerms, termsChangeReason: termsReason === '' ? null : termsReason,
      paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
        ? { kind: mode, eventDate, eventTime, timezone, balanceDate, balanceTime, timingExceptionReason: timingReason === '' ? null : timingReason }
        : { kind: mode, balanceDate, balanceTime, timezone, agreedBalanceCents: expectedBalance! },
      linkExpiration: expiration === 'never' ? { kind: 'never' } : { kind: 'at', date: expirationDate, time: expirationTime, timezone: expirationTimezone } };
    try { const command = exactPaymentConfigurationV2Command(view, status, crypto.randomUUID(), preparation.id, facts); setError(null); onCommand(command); }
    catch { setError('Revisa condiciones, importes, fechas, horas, zonas horarias y motivos explícitos antes de guardar. Las fechas deben ser futuras y no ambiguas.'); }
  }
  return <form onSubmit={save} data-testid="payment-v2-conditions-form">
    <fieldset className="gew-attestation" disabled={!enabled}><legend>Condiciones del borrador de prueba</legend>
      <p>Completa los hechos que se revisarán. El servidor resolverá el lead de prueba; esta operación no autoriza un acuerdo comercial.</p>
      <p className="gew-muted">Una vez guardadas, estas condiciones no se editan. Para cambiarlas, crea una nueva versión de cotización y preparación.</p>
      <div className="gew-editor-fields">
        <label>Condiciones de pago explícitas<textarea data-testid="payment-v2-terms" value={paymentTerms} maxLength={4000} required onChange={event => setPaymentTerms(event.target.value)} /></label>
        <button type="button" className="gew-button" onClick={() => setPaymentTerms(preparation.terms)}>Copiar condiciones de la cotización</button>
        <label>Motivo de revisión de condiciones{reasonRequired ? ' · obligatorio' : ' · opcional'}<textarea data-testid="payment-v2-terms-reason" value={termsReason} maxLength={2000} required={reasonRequired} onChange={event => setTermsReason(event.target.value)} /></label>
        {mode !== 'full_upfront' && <>
          {mode === 'retainer_50' && <>
            <label>Fecha explícita del evento<input data-testid="payment-v2-event-date" type="date" value={eventDate} required onChange={event => setEventDate(event.target.value)} /></label>
            <label>Hora explícita del evento<input data-testid="payment-v2-event-time" type="time" value={eventTime} required onChange={event => setEventTime(event.target.value)} /></label>
          </>}
          <label>Zona horaria del calendario<input data-testid="payment-v2-calendar-timezone" value={timezone} maxLength={64} placeholder="Ejemplo: America/New_York" required onChange={event => setTimezone(event.target.value)} /></label>
          {proposal?.proposedBalanceDate && <p data-testid="payment-v2-date-proposal">Fecha propuesta para el saldo: {proposal.proposedBalanceDate}. Requiere revisión y una hora explícita.
            <button type="button" className="gew-button" onClick={() => setBalanceDate(proposal.proposedBalanceDate!)}>Usar fecha propuesta</button>
            {proposal.requiresExplicitReview && <span> La propuesta requiere un motivo de revisión explícito.</span>}</p>}
          <label>Fecha explícita del saldo<input data-testid="payment-v2-balance-date" type="date" value={balanceDate} required onChange={event => setBalanceDate(event.target.value)} /></label>
          <label>Hora explícita del saldo<input data-testid="payment-v2-balance-time" type="time" value={balanceTime} required onChange={event => setBalanceTime(event.target.value)} /></label>
          {mode === 'retainer_50' ? <label>Motivo de excepción del calendario · si corresponde<textarea data-testid="payment-v2-timing-reason" value={timingReason} maxLength={2000} onChange={event => setTimingReason(event.target.value)} /></label>
            : <label>Saldo acordado en USD · debe coincidir con {money(preparation.paymentBalanceCents)}<input data-testid="payment-v2-agreed-balance" inputMode="decimal" maxLength={18} value={agreedBalance} placeholder="0.00" required onChange={event => setAgreedBalance(event.target.value)} /></label>}
        </>}
        {mode === 'full_upfront' && <p>Pago único: {money(preparation.initialPaymentCents)}. Sin saldo futuro ni calendario de saldo.</p>}
        <label>Expiración del eventual enlace de prueba<select data-testid="payment-v2-expiration" value={expiration} required onChange={event => setExpiration(event.target.value as '' | 'never' | 'at')}>
          <option value="">Selecciona una expiración explícita</option><option value="never">Sin expiración</option><option value="at">Fecha y hora explícitas</option>
        </select></label>
        {expiration === 'at' && <>
          <label>Fecha de expiración<input data-testid="payment-v2-expiration-date" type="date" value={expirationDate} required onChange={event => setExpirationDate(event.target.value)} /></label>
          <label>Hora de expiración<input data-testid="payment-v2-expiration-time" type="time" value={expirationTime} required onChange={event => setExpirationTime(event.target.value)} /></label>
          <label>Zona horaria de expiración<input data-testid="payment-v2-expiration-timezone" value={expirationTimezone} maxLength={64} required onChange={event => setExpirationTimezone(event.target.value)} /></label>
        </>}
      </div>
      <button type="submit" className="gew-button gew-button-primary" data-testid="payment-v2-configure" disabled={!enabled || !complete}>Guardar condiciones de prueba</button>
    </fieldset>
    {error && <p className="gew-notice gew-notice-warning" role="alert">{error}</p>}
  </form>;
}

export function PaymentConfigurationReviewV2({ view, status, configuration, enabled, onCommand, showApproval = true, registered = false }: {
  view: EventQuoteView; status: EventQuoteStatusResponse; configuration: PaymentConfigurationV2; enabled: boolean; onCommand(command: QuoteCommand): void; showApproval?: boolean; registered?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState<string | null>(null);
  const preparation = view.record.paymentContractPreparationsV2!.find(p => p.id === configuration.preparationId)!;
  const facts = configuration.configuration, schedule = facts.paymentSchedule;
  useEffect(() => { if (!enabled || !showApproval) setConfirmed(false); }, [enabled, showApproval]);
  function register() {
    if (!enabled || !showApproval || !confirmed) return;
    try { const command = exactPaymentDraftRegistrationV2Command(view, status, crypto.randomUUID(), configuration.id); setError(null); setConfirmed(false); onCommand(command); }
    catch { setConfirmed(false); setError('La revisión cambió o dejó de estar vigente. Recarga y revisa los hechos guardados antes de confirmar.'); }
  }
  return <div data-testid="persisted-payment-v2-review">
    <h5>{registered ? 'Condiciones del acuerdo borrador' : showApproval ? 'Revisar condiciones guardadas y confirmar borrador' : 'Condiciones guardadas del borrador'}</h5>
    <p>Fuente del lead: fixture sintético resuelto por el servidor. Sin autorización comercial.</p>
    <p className="gew-muted">Una vez guardadas, estas condiciones no se editan. Para cambiarlas, crea una nueva versión de cotización y preparación.</p>
    <dl>
      <dt>Cotización original</dt><dd>v{preparation.quoteVersion} · total {money(preparation.totalCents)} · anticipo {money(preparation.depositCents)} ({preparation.depositBasis.basisPoints / 100} %)</dd>
      <dt>Condiciones originales</dt><dd>{preparation.terms}</dd>
      <dt>Condiciones configuradas</dt><dd>{facts.paymentTerms}</dd>
      <dt>Motivo de revisión</dt><dd>{facts.termsChangeReason ?? 'Sin cambio de condiciones cotizadas'}</dd>
      <dt>Pago inicial del borrador</dt><dd>{money(preparation.initialPaymentCents)}</dd>
      <dt>Saldo del borrador</dt><dd>{preparation.paymentMode === 'full_upfront' ? 'Sin saldo futuro' : money(preparation.paymentBalanceCents)}</dd>
      {schedule && <><dt>Calendario del saldo</dt><dd>{schedule.balanceDate} {schedule.balanceTime} · {schedule.timezone}</dd></>}
      {schedule?.kind === 'retainer_50' && <><dt>Evento explícito</dt><dd>{schedule.eventDate} {schedule.eventTime} · {schedule.timezone}</dd><dt>Motivo de excepción del calendario</dt><dd>{schedule.timingExceptionReason ?? 'Sin excepción solicitada'}</dd></>}
      <dt>Expiración</dt><dd>{facts.linkExpiration.kind === 'never' ? 'Sin expiración, elegido explícitamente' : `${facts.linkExpiration.date} ${facts.linkExpiration.time} · ${facts.linkExpiration.timezone}`}</dd>
    </dl>
    <p className="gew-muted">Huella de los hechos revisados: <span className="gew-hash">{configuration.reviewDigest}</span></p>
    {showApproval && <><label className="gew-check"><input data-testid="payment-v2-confirm-review" type="checkbox" checked={confirmed} disabled={!enabled} onChange={event => setConfirmed(event.target.checked)} />Revisé la cotización original, la modalidad, los importes, las condiciones, el calendario y la expiración guardados para este borrador de prueba.</label>
    <button type="button" className="gew-button gew-button-primary" data-testid="payment-v2-register" disabled={!enabled || !confirmed} onClick={register}>Confirmar acuerdo borrador de prueba</button></>}
    <p className="gew-muted">La confirmación valida un borrador interno de prueba. No crea un enlace ni acredita aceptación del cliente, pago o autorización comercial.</p>
    {error && <p className="gew-notice gew-notice-warning" role="alert">{error}</p>}
  </div>;
}
