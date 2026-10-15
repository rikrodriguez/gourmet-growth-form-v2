<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Payments\VerifiedWebhook;

final class PayPalClient implements PayPalGateway
{
    private ?string $accessToken = null;
    private int $accessTokenExpiresAt = 0;

    public function __construct(
        private readonly PayPalConfig $config,
        private readonly PayPalHttpTransport $transport,
        private readonly int $timeoutSeconds = 20,
    ) {
    }

    public function getAccessToken(): string
    {
        if ($this->config->missingCredentials() !== []) {
            throw new \RuntimeException('PayPal credentials are not configured.');
        }
        if ($this->accessToken !== null && $this->accessTokenExpiresAt > time() + 30) {
            return $this->accessToken;
        }

        $response = $this->transport->send(
            'POST',
            $this->config->baseUrl() . '/v1/oauth2/token',
            [
                'Accept' => 'application/json',
                'Authorization' => 'Basic ' . base64_encode($this->config->clientId . ':' . $this->config->clientSecret),
                'Content-Type' => 'application/x-www-form-urlencoded',
            ],
            'grant_type=client_credentials',
            $this->timeoutSeconds,
        );
        $payload = $this->decode($response);
        $token = $payload['access_token'] ?? null;
        if (!is_string($token) || $token === '') {
            throw new PayPalApiException($response->status, 'INVALID_RESPONSE', null, null);
        }

        $this->accessToken = $token;
        $expiresIn = is_numeric($payload['expires_in'] ?? null) ? (int) $payload['expires_in'] : 300;
        $this->accessTokenExpiresAt = time() + max(60, $expiresIn);

        return $token;
    }

    public function createProduct(array $payload, string $requestId): array
    {
        return $this->jsonRequest('POST', '/v1/catalogs/products', $payload, $requestId);
    }

    public function getProduct(string $productId): array
    {
        return $this->jsonRequest('GET', '/v1/catalogs/products/' . rawurlencode($productId));
    }

    public function createPlan(array $payload, string $requestId): array
    {
        return $this->jsonRequest('POST', '/v1/billing/plans', $payload, $requestId);
    }

    public function getPlan(string $planId): array
    {
        return $this->jsonRequest('GET', '/v1/billing/plans/' . rawurlencode($planId));
    }

    public function createSubscription(array $payload, string $requestId): array
    {
        return $this->jsonRequest('POST', '/v1/billing/subscriptions', $payload, $requestId);
    }

    public function getSubscription(string $subscriptionId): array
    {
        return $this->jsonRequest('GET', '/v1/billing/subscriptions/' . rawurlencode($subscriptionId) . '?fields=plan,last_failed_payment');
    }

    public function cancelSubscription(string $subscriptionId, string $reason): void
    {
        $this->jsonRequest('POST', '/v1/billing/subscriptions/' . rawurlencode($subscriptionId) . '/cancel', [
            'reason' => mb_substr($reason, 0, 128),
        ]);
    }

    public function listTransactions(string $subscriptionId, \DateTimeImmutable $start, \DateTimeImmutable $end): array
    {
        $query = http_build_query([
            'start_time' => $start->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
            'end_time' => $end->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
        ], '', '&', PHP_QUERY_RFC3986);
        $response = $this->jsonRequest(
            'GET',
            '/v1/billing/subscriptions/' . rawurlencode($subscriptionId) . '/transactions?' . $query,
        );
        $transactions = $response['transactions'] ?? [];
        if (!is_array($transactions)) {
            throw new PayPalApiException(200, 'INVALID_RESPONSE', null, null);
        }

        return array_values(array_filter($transactions, 'is_array'));
    }

    /** @param array<string, string> $headers */
    public function verifyWebhook(string $rawPayload, array $headers): VerifiedWebhook
    {
        if (!$this->config->canVerifyWebhooks()) {
            throw new \RuntimeException('PayPal webhook verification is not configured.');
        }
        $event = json_decode($rawPayload, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($event)) {
            throw new \DomainException('Webhook event must be a JSON object.');
        }
        $normalized = array_change_key_case($headers, CASE_LOWER);
        $required = [
            'paypal-auth-algo' => 'auth_algo',
            'paypal-cert-url' => 'cert_url',
            'paypal-transmission-id' => 'transmission_id',
            'paypal-transmission-sig' => 'transmission_sig',
            'paypal-transmission-time' => 'transmission_time',
        ];
        $verification = ['webhook_id' => $this->config->webhookId, 'webhook_event' => $event];
        foreach ($required as $header => $field) {
            $value = $normalized[$header] ?? '';
            if ($value === '') {
                throw new \DomainException('Required PayPal webhook signature header is missing.');
            }
            $verification[$field] = $value;
        }

        $result = $this->jsonRequest('POST', '/v1/notifications/verify-webhook-signature', $verification);
        if (($result['verification_status'] ?? null) !== 'SUCCESS') {
            throw new \DomainException('PayPal webhook signature verification failed.');
        }
        $eventId = $event['id'] ?? null;
        $eventType = $event['event_type'] ?? null;
        if (!is_string($eventId) || $eventId === '' || !is_string($eventType) || $eventType === '') {
            throw new \DomainException('Verified PayPal webhook identity is incomplete.');
        }

        return new VerifiedWebhook($eventId, $eventType, hash('sha256', $rawPayload));
    }

    /** @param array<string, mixed>|null $payload @return array<string, mixed> */
    private function jsonRequest(string $method, string $path, ?array $payload = null, ?string $requestId = null): array
    {
        $headers = [
            'Accept' => 'application/json',
            'Authorization' => 'Bearer ' . $this->getAccessToken(),
            'Content-Type' => 'application/json',
        ];
        if ($requestId !== null) {
            $headers['PayPal-Request-Id'] = $requestId;
            $headers['Prefer'] = 'return=representation';
        }
        $body = $payload === null ? null : json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $response = $this->transport->send(
            $method,
            $this->config->baseUrl() . $path,
            $headers,
            $body,
            $this->timeoutSeconds,
        );

        return $this->decode($response);
    }

    /** @return array<string, mixed> */
    private function decode(PayPalHttpResponse $response): array
    {
        $decoded = $response->body === '' ? [] : json_decode($response->body, true);
        $payload = is_array($decoded) ? $decoded : [];
        if ($response->status < 200 || $response->status >= 300) {
            $category = match ($response->status) {
                401 => 'AUTHENTICATION',
                403 => 'AUTHORIZATION',
                404 => 'NOT_FOUND',
                409 => 'CONFLICT',
                422 => 'VALIDATION',
                default => $response->status >= 500 ? 'PROVIDER_ERROR' : 'REQUEST_ERROR',
            };
            throw new PayPalApiException(
                $response->status,
                $category,
                is_string($payload['name'] ?? null) ? $payload['name'] : null,
                is_string($payload['debug_id'] ?? null) ? $payload['debug_id'] : null,
            );
        }
        if ($response->body !== '' && !is_array($decoded)) {
            throw new PayPalApiException($response->status, 'INVALID_RESPONSE', null, null);
        }

        return $payload;
    }
}
