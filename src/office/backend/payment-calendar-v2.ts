/** Pure calendar proposals only. No approved charge time, policy or transport. */
export type PaymentCalendarProposalCodeV2 =
  | 'INVALID_NOW'
  | 'EVENT_DATE_REQUIRED'
  | 'INVALID_EVENT_DATE'
  | 'EVENT_TIME_REQUIRED'
  | 'INVALID_EVENT_TIME'
  | 'TIMEZONE_REQUIRED'
  | 'INVALID_TIMEZONE'
  | 'EVENT_LOCAL_MINUTE_UNRESOLVED'
  | 'EVENT_DATE_NOT_FUTURE'
  | 'EVENT_WITHIN_SEVEN_DAYS'
  | 'PROPOSED_BALANCE_DATE_PAST'
  | 'PROPOSED_BALANCE_DATE_TODAY'
  | 'BALANCE_DATE_OUT_OF_RANGE';

export type RetainerBalanceDateProposalV2 = Readonly<{
  proposedBalanceDate: string | null;
  requiresExplicitReview: boolean;
  codes: readonly PaymentCalendarProposalCodeV2[];
}>;

export type RetainerBalanceDateInputV2 = Readonly<{
  eventDate: string | null;
  eventTime: string | null;
  timezone: string | null;
  nowMs: number;
}>;

const DAY_MS = 86_400_000;

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timezoneFormatter(timezone: unknown): Intl.DateTimeFormat | null {
  // Intl accepts abbreviations and numeric offsets whose meanings are not the
  // agreed named zone. UTC is the explicit zero-offset exception.
  if (typeof timezone !== 'string' || timezone.trim() !== timezone || timezone.length > 64
    || !(timezone === 'UTC' || timezone.includes('/'))) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch { return null; }
}

function supportedInstant(date: Date): boolean {
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
}

function wallSecond(date: Date, formatter: Intl.DateTimeFormat): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  if (parts.era !== 'AD' || !/^\d{1,4}$/.test(parts.year ?? '') || Number(parts.year) < 1) return null;
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * Resolve an explicitly supplied local minute, never a date-only proposal.
 * Exactly one instant must reproduce its wall date, hour, minute and zero local
 * seconds. Both DST fold instants and nonexistent wall minutes are rejected.
 * Historical named-zone offsets with seconds retain their exact UTC seconds.
 * This does not attest approval, future eligibility or consent.
 */
export function resolveApprovedLocalMinuteV2(date: string, time: string, timezone: string): string | null {
  if (!validDate(date) || !validTime(time)) return null;
  const formatter = timezoneFormatter(timezone);
  if (!formatter) return null;
  const wall = `${date}T${time}:00`, naive = Date.parse(`${wall}Z`);
  const offsets = new Set<number>(), matches = new Set<number>();
  // Observe both sides of timezone transitions, including half-hour DST and
  // skipped calendar days. These samples discover offsets, not guessed hours.
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = naive + hours * 3_600_000;
    const local = wallSecond(new Date(instant), formatter);
    if (local !== null) offsets.add(Date.parse(`${local}Z`) - instant);
  }
  for (const offset of offsets) {
    const candidate = naive - offset, instant = new Date(candidate);
    if (supportedInstant(instant) && wallSecond(instant, formatter) === wall) matches.add(candidate);
  }
  if (matches.size !== 1) return null;
  return new Date([...matches][0]).toISOString().replace('.000Z', 'Z');
}

/**
 * Propose only the retainer_50 balance calendar date. Normal approval must still
 * supply its own balance hour. Review flags never move a past proposal to today
 * or replace a missing timezone/event time with inferred brief content.
 */
export function proposeRetainerBalanceDateV2(input: RetainerBalanceDateInputV2): RetainerBalanceDateProposalV2 {
  const codes: PaymentCalendarProposalCodeV2[] = [];
  const clock = new Date(input.nowMs);
  let validNow = Number.isSafeInteger(input.nowMs) && supportedInstant(clock);
  if (!validNow) codes.push('INVALID_NOW');
  const dateValid = validDate(input.eventDate), timeValid = validTime(input.eventTime);
  if (input.eventDate === null) codes.push('EVENT_DATE_REQUIRED');
  else if (!dateValid) codes.push('INVALID_EVENT_DATE');
  if (input.eventTime === null) codes.push('EVENT_TIME_REQUIRED');
  else if (!timeValid) codes.push('INVALID_EVENT_TIME');
  const formatter = timezoneFormatter(input.timezone);
  if (input.timezone === null) codes.push('TIMEZONE_REQUIRED');
  else if (!formatter) codes.push('INVALID_TIMEZONE');
  let today: string | null = null;
  if (formatter && validNow) {
    today = wallSecond(clock, formatter)?.slice(0, 10) ?? null;
    if (today === null) { validNow = false; codes.push('INVALID_NOW'); }
  }

  let proposedBalanceDate: string | null = null;
  if (dateValid && formatter && validNow) {
    // Arithmetic uses UTC only as an index for Gregorian calendar labels. It
    // does not subtract 168 hours from an event instant in the business zone.
    const previous = new Date(Date.parse(`${input.eventDate}T00:00:00Z`) - 7 * DAY_MS);
    if (supportedInstant(previous)) proposedBalanceDate = previous.toISOString().slice(0, 10);
    else codes.push('BALANCE_DATE_OUT_OF_RANGE');
    if (timeValid && resolveApprovedLocalMinuteV2(input.eventDate, input.eventTime, input.timezone!) === null)
      codes.push('EVENT_LOCAL_MINUTE_UNRESOLVED');
    if (today !== null) {
      const daysAhead = (Date.parse(`${input.eventDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
      if (daysAhead <= 0) codes.push('EVENT_DATE_NOT_FUTURE');
      else if (daysAhead < 7) codes.push('EVENT_WITHIN_SEVEN_DAYS');
      if (proposedBalanceDate !== null && proposedBalanceDate < today) codes.push('PROPOSED_BALANCE_DATE_PAST');
      else if (proposedBalanceDate === today) codes.push('PROPOSED_BALANCE_DATE_TODAY');
    }
  }
  return { proposedBalanceDate, requiresExplicitReview: codes.length > 0, codes };
}
