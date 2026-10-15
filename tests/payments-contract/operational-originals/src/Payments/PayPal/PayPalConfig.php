<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Support\Env;

final readonly class PayPalConfig
{
    private const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
    private const LIVE_BASE_URL = 'https://api-m.paypal.com';

    public function __construct(
        public string $mode,
        public string $clientId,
        public string $clientSecret,
        public string $webhookId,
    ) {
        if (!in_array($this->mode, ['sandbox', 'live'], true)) {
            throw new \DomainException('PAYPAL_MODE must be sandbox or live.');
        }
    }

    public static function fromEnv(Env $env): self
    {
        return new self(
            mode: $env->get('PAYPAL_MODE', 'sandbox') ?? 'sandbox',
            clientId: $env->get('PAYPAL_CLIENT_ID', '') ?? '',
            clientSecret: $env->get('PAYPAL_CLIENT_SECRET', '') ?? '',
            webhookId: $env->get('PAYPAL_WEBHOOK_ID', '') ?? '',
        );
    }

    public function baseUrl(): string
    {
        return $this->mode === 'live' ? self::LIVE_BASE_URL : self::SANDBOX_BASE_URL;
    }

    /** @return list<string> */
    public function missingCredentials(): array
    {
        $missing = [];
        if ($this->clientId === '') {
            $missing[] = 'PAYPAL_CLIENT_ID';
        }
        if ($this->clientSecret === '') {
            $missing[] = 'PAYPAL_CLIENT_SECRET';
        }

        return $missing;
    }

    public function canVerifyWebhooks(): bool
    {
        return $this->missingCredentials() === [] && $this->webhookId !== '';
    }
}
