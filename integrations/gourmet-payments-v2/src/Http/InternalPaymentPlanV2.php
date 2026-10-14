<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

use Gourmet\Payments\Domain\Money;

/**
 * Unregistered, side-effect-free v2 contract boundary.
 *
 * Input is the complete canonical prepared_internal evidence from Sales OS.
 * Integrity and arithmetic checks cannot authenticate an actor or attest a
 * current source record. This class never creates an agreement, token, URL,
 * database record, provider client or dispatch intent.
 */
final class InternalPaymentPlanV2
{
    private const MAX_BYTES = 131072;
    private const MAX_CENTS = 1000000000;
    private const MAX_JS_INTEGER = 9007199254740991;
    private const MAX_NOW_MS = 8640000000000000;
    private const JS_SPACE = '\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}';

    /** @return array<string,mixed> */
    public static function validate(string $rawBody, int $nowMs): array
    {
        if ($nowMs < 0 || $nowMs > self::MAX_NOW_MS) {
            throw new \DomainException('INVALID_NOW');
        }
        if ($rawBody === '' || strlen($rawBody) > self::MAX_BYTES) {
            throw new \DomainException('INVALID_CANONICAL_JSON');
        }
        try {
            $prepared = json_decode($rawBody, false, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \DomainException('INVALID_CANONICAL_JSON');
        }
        // The wire form is canonical JS JSON, including literal Unicode and
        // slashes. Comparing the entire raw form also rejects duplicate keys,
        // alternate number forms, escaped aliases and whitespace ambiguity.
        if (self::canonical($prepared) !== $rawBody) {
            throw new \DomainException('INVALID_CANONICAL_JSON');
        }
        $value = self::object($prepared, [
            'status', 'contractVersion', 'plan', 'reviewDigest', 'internalApproval',
            'executable', 'providerEnabled', 'publicPaymentUrl', 'blockers',
        ]);
        self::check($value->status === 'prepared_internal' && $value->contractVersion === 2
            && $value->executable === false && $value->providerEnabled === false && $value->publicPaymentUrl === null);
        self::check($value->blockers === ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE']);
        self::hashValue($value->reviewDigest);

        $plan = self::object($value->plan, [
            'contractVersion', 'scope', 'eventId', 'preparationId', 'preparationDigest',
            'sourceQuote', 'paymentMode', 'initialPaymentCents', 'paymentBalanceCents',
            'canonicalLeadId', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration',
        ]);
        self::check($plan->contractVersion === 2);
        $scope = self::object($plan->scope, ['organizationId', 'workspaceId', 'mode']);
        self::identifier($scope->organizationId);
        self::identifier($scope->workspaceId);
        self::check(in_array($scope->mode, ['test', 'commercial'], true));
        self::identifier($plan->eventId);
        self::identifier($plan->preparationId);
        self::hashValue($plan->preparationDigest);

        $quote = self::object($plan->sourceQuote, [
            'version', 'digest', 'approvalDigest', 'briefDigest', 'catalogDigest',
            'artifactSha256', 'intendedRecipient', 'currency', 'totalCents',
            'depositCents', 'depositBasis', 'terms',
        ]);
        self::integer($quote->version, 1, 20);
        foreach (['digest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256'] as $field) {
            self::hashValue($quote->{$field});
        }
        self::text($quote->intendedRecipient, 254);
        $nonEmail = self::JS_SPACE . '@<>';
        self::check(preg_match('/^[^' . $nonEmail . ']+@[^' . $nonEmail . ']+\.[^' . $nonEmail . ']+$/uD', $quote->intendedRecipient) === 1);
        self::check($quote->currency === 'USD');
        self::integer($quote->totalCents, 1, self::MAX_CENTS);
        self::integer($quote->depositCents, 0, $quote->totalCents);
        $basis = self::object($quote->depositBasis, ['kind', 'basisPoints']);
        self::check($basis->kind === 'quoted_percentage');
        self::integer($basis->basisPoints, 0, 10000);
        // MAX_CENTS is the actual quote bound. The product stays far below
        // PHP_INT_MAX; no floating point or percentage equivalence is used.
        self::check($quote->depositCents === intdiv($quote->totalCents * $basis->basisPoints + 5000, 10000));
        self::text($quote->terms, 4000);

        self::check(in_array($plan->paymentMode, ['retainer_50', 'full_upfront', 'fixed_49_reservation'], true));
        self::integer($plan->initialPaymentCents, 1, self::MAX_CENTS);
        self::integer($plan->paymentBalanceCents, 0, self::MAX_CENTS);
        self::check($plan->initialPaymentCents + $plan->paymentBalanceCents === $quote->totalCents);
        if ($plan->paymentMode === 'retainer_50') {
            self::check($plan->initialPaymentCents === intdiv($quote->totalCents + 1, 2) && $plan->paymentBalanceCents > 0);
        } elseif ($plan->paymentMode === 'full_upfront') {
            self::check($plan->initialPaymentCents === $quote->totalCents && $plan->paymentBalanceCents === 0);
        } else {
            // The original receiver's pure Money invariant is reused only for
            // its explicit fixed-reservation mode. It must be loaded by the
            // host; this boundary never boots or autoloads the application.
            if (!class_exists(Money::class, false)) {
                throw new \DomainException('ORIGINAL_MONEY_UNAVAILABLE');
            }
            try {
                $money = Money::agreement($quote->totalCents, $quote->currency);
            } catch (\DomainException) {
                throw new \DomainException('INVALID_PAYMENT_PLAN_V2');
            }
            self::check($money->reservationCents === 4900
                && $plan->initialPaymentCents === $money->reservationCents
                && $plan->paymentBalanceCents === $money->balanceCents);
        }
        $expectedId = 'payment-contract-v2-' . hash('sha256', self::canonical((object) [
            'contractVersion' => 2, 'scope' => $scope, 'eventId' => $plan->eventId,
            'quoteVersion' => $quote->version, 'quoteDigest' => $quote->digest,
            'approvalDigest' => $quote->approvalDigest, 'paymentMode' => $plan->paymentMode,
        ]));
        self::check($plan->preparationId === $expectedId);

        self::text($plan->canonicalLeadId, 180);
        self::check(self::trimJs($plan->canonicalLeadId) === $plan->canonicalLeadId
            && preg_match('/[\r\n\t]/', $plan->canonicalLeadId) !== 1);
        self::text($plan->paymentTerms, 4000);
        self::nullableText($plan->termsChangeReason, 2000);
        $quotedMatches = $plan->paymentMode !== 'fixed_49_reservation'
            && $quote->depositCents === $plan->initialPaymentCents
            && $basis->basisPoints === ($plan->paymentMode === 'retainer_50' ? 5000 : 10000);
        if (!$quotedMatches || $plan->paymentTerms !== $quote->terms) {
            self::text($plan->termsChangeReason, 2000);
        }
        self::expiration($plan->linkExpiration, $nowMs);
        self::schedule($plan, $nowMs);
        self::check(hash_equals(hash('sha256', self::canonical($plan)), $value->reviewDigest));

        $approval = self::object($value->internalApproval, ['actorId', 'atMs', 'purpose', 'reviewDigest']);
        self::identifier($approval->actorId);
        self::integer($approval->atMs, 0, $nowMs);
        self::check($approval->purpose === 'internal_payment_plan_only'
            && $approval->reviewDigest === $value->reviewDigest);

        return [
            'status' => 'contract_validated_internal',
            'prepared' => $prepared,
            'executable' => false,
            'providerEnabled' => false,
            'publicPaymentUrl' => null,
            'authorizationVerified' => false,
        ];
    }

    private static function expiration(mixed $raw, int $nowMs): void
    {
        $expiration = self::object($raw, ['configured', 'instant']);
        $configured = $expiration->configured;
        self::check($configured instanceof \stdClass);
        if (($configured->kind ?? null) === 'never') {
            self::object($configured, ['kind']);
            self::check($expiration->instant === null);
            return;
        }
        self::object($configured, ['kind', 'date', 'time', 'timezone']);
        self::check($configured->kind === 'at');
        $date = self::futureMinute($configured->date, $configured->time, $configured->timezone, $nowMs);
        self::check($expiration->instant === self::utc($date));
    }

    private static function schedule(\stdClass $plan, int $nowMs): void
    {
        if ($plan->paymentMode === 'full_upfront') {
            self::check($plan->paymentSchedule === null);
            return;
        }
        $schedule = self::object($plan->paymentSchedule, [
            'configured', 'balanceInstant', 'eventInstant', 'proposedBalanceDate', 'timingReviewReason',
        ]);
        if ($plan->paymentMode === 'fixed_49_reservation') {
            $configured = self::object($schedule->configured, ['kind', 'balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']);
            self::check($configured->kind === 'fixed_49_reservation' && $configured->agreedBalanceCents === $plan->paymentBalanceCents);
            $balance = self::futureMinute($configured->balanceDate, $configured->balanceTime, $configured->timezone, $nowMs);
            self::check($schedule->balanceInstant === self::utc($balance)
                && $schedule->eventInstant === null && $schedule->proposedBalanceDate === null && $schedule->timingReviewReason === null);
            return;
        }
        $configured = self::object($schedule->configured, [
            'kind', 'eventDate', 'eventTime', 'timezone', 'balanceDate', 'balanceTime', 'timingExceptionReason',
        ]);
        self::check($configured->kind === 'retainer_50');
        self::nullableText($configured->timingExceptionReason, 2000);
        $event = self::futureMinute($configured->eventDate, $configured->eventTime, $configured->timezone, $nowMs);
        $balance = self::futureMinute($configured->balanceDate, $configured->balanceTime, $configured->timezone, $nowMs);
        self::check($balance < $event && $schedule->eventInstant === self::utc($event) && $schedule->balanceInstant === self::utc($balance));

        // Subtract Gregorian calendar labels, not 168 elapsed UTC hours. The
        // explicit balance hour remains independent from the event hour.
        $eventDay = self::day($configured->eventDate);
        $proposed = $eventDay->sub(new \DateInterval('P7D'))->format('Y-m-d');
        self::day($proposed);
        self::check($schedule->proposedBalanceDate === $proposed);
        $today = self::now($nowMs)->setTimezone(self::timezone($configured->timezone))->format('Y-m-d');
        $todayDay = self::day($today);
        $daysAhead = (int) $todayDay->diff($eventDay)->format('%r%a');
        $needsReason = $configured->balanceDate !== $proposed
            || $daysAhead <= 0 || $daysAhead < 7 || $proposed < $today;
        if ($needsReason) {
            self::text($configured->timingExceptionReason, 2000);
        }
        self::check($schedule->timingReviewReason === $configured->timingExceptionReason);
    }

    private static function futureMinute(mixed $date, mixed $time, mixed $timezone, int $nowMs): \DateTimeImmutable
    {
        $resolved = self::localMinute($date, $time, $timezone);
        self::check($resolved->getTimestamp() * 1000 > $nowMs && $resolved->format('s') === '00');
        return $resolved;
    }

    /**
     * V1's exact DateTime calendar/format round trip is retained. V2 supplies an
     * explicit clock and additionally requires a unique named-zone instant.
     * The old method is private in Application; no production Reflection or
     * Application instance is used here.
     */
    private static function localMinute(mixed $date, mixed $time, mixed $timezone): \DateTimeImmutable
    {
        self::day($date);
        self::check(is_string($time) && preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/D', $time) === 1);
        $zone = self::timezone($timezone);
        $wall = $date . 'T' . $time;
        $naive = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $wall, new \DateTimeZone('UTC'));
        $errors = \DateTimeImmutable::getLastErrors();
        self::check($naive !== false && ($errors === false || $errors['warning_count'] + $errors['error_count'] === 0)
            && $naive->format('Y-m-d\TH:i') === $wall);
        $seconds = $naive->getTimestamp();
        $offsets = [];
        foreach ($zone->getTransitions($seconds - 129600, $seconds + 129600) ?: [] as $transition) {
            $offsets[$transition['offset']] = true;
        }
        // Include constant-offset IANA zones as well as transition zones.
        $offsets[$zone->getOffset($naive)] = true;
        $matches = [];
        foreach (array_keys($offsets) as $offset) {
            $candidate = (new \DateTimeImmutable('@' . ($seconds - $offset)))->setTimezone($zone);
            $utcYear = (int) $candidate->setTimezone(new \DateTimeZone('UTC'))->format('Y');
            if ($utcYear >= 1 && $utcYear <= 9999 && $candidate->format('Y-m-d\TH:i:s') === $wall . ':00') {
                $matches[$candidate->getTimestamp()] = $candidate->setTimezone(new \DateTimeZone('UTC'));
            }
        }
        self::check(count($matches) === 1);
        return array_values($matches)[0];
    }

    private static function day(mixed $value): \DateTimeImmutable
    {
        self::check(is_string($value) && preg_match('/^(?!0000)\d{4}-\d{2}-\d{2}$/D', $value) === 1);
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        $errors = \DateTimeImmutable::getLastErrors();
        self::check($date !== false && ($errors === false || $errors['warning_count'] + $errors['error_count'] === 0)
            && $date->format('Y-m-d') === $value);
        return $date;
    }

    private static function timezone(mixed $value): \DateTimeZone
    {
        self::check(is_string($value) && self::trimJs($value) === $value && self::utf16Length($value) <= 64
            && preg_match('/[\x00-\x1f\x7f]/', $value) !== 1
            && ($value === 'UTC' || str_contains($value, '/')));
        try {
            return new \DateTimeZone($value);
        } catch (\Exception | \ValueError) {
            throw new \DomainException('INVALID_PAYMENT_PLAN_V2');
        }
    }

    private static function now(int $nowMs): \DateTimeImmutable
    {
        return (new \DateTimeImmutable('@' . intdiv($nowMs, 1000)))->setTimezone(new \DateTimeZone('UTC'));
    }

    private static function utc(\DateTimeImmutable $date): string
    {
        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    /** @param list<string> $keys */
    private static function object(mixed $value, array $keys): \stdClass
    {
        self::check($value instanceof \stdClass);
        $actual = array_keys(get_object_vars($value));
        sort($actual, SORT_STRING); sort($keys, SORT_STRING);
        self::check($actual === $keys);
        return $value;
    }

    private static function identifier(mixed $value): void
    {
        self::text($value, 96);
        self::check(preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $value) === 1
            && !in_array($value, ['constructor', 'prototype', '__proto__'], true));
    }

    private static function hashValue(mixed $value): void
    {
        self::check(is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) === 1);
    }

    private static function integer(mixed $value, int $min, int $max): void
    {
        self::check(is_int($value) && $value >= $min && $value <= $max && $value <= self::MAX_JS_INTEGER);
    }

    private static function text(mixed $value, int $max): void
    {
        self::check(is_string($value) && self::trimJs($value) !== '' && self::utf16Length($value) <= $max
            && preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u', $value) !== 1);
    }

    private static function nullableText(mixed $value, int $max): void
    {
        if ($value !== null) {
            self::text($value, $max);
        }
    }

    private static function trimJs(string $value): string
    {
        return preg_replace('/^[' . self::JS_SPACE . ']+|[' . self::JS_SPACE . ']+$/u', '', $value) ?? $value;
    }

    private static function utf16Length(string $value): int
    {
        return intdiv(strlen(mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    private static function canonical(mixed $value): string
    {
        if ($value instanceof \stdClass) {
            $fields = get_object_vars($value); ksort($fields, SORT_STRING); $parts = [];
            foreach ($fields as $key => $item) {
                $parts[] = self::canonical((string) $key) . ':' . self::canonical($item);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($value)) {
            return '[' . implode(',', array_map(self::canonical(...), $value)) . ']';
        }
        if ($value !== null && !is_string($value) && !is_bool($value) && !is_int($value)) {
            throw new \DomainException('INVALID_CANONICAL_JSON');
        }
        try {
            return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS);
        } catch (\JsonException) {
            throw new \DomainException('INVALID_CANONICAL_JSON');
        }
    }

    private static function check(bool $condition): void
    {
        if (!$condition) {
            throw new \DomainException('INVALID_PAYMENT_PLAN_V2');
        }
    }
}
