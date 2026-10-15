<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

use Gourmet\Payments\Auth\AdminAuth;
use Gourmet\Payments\Auth\AdminBootstrap;
use Gourmet\Payments\Database\AuditLog;
use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\IdempotencyGuard;
use Gourmet\Payments\Database\PaymentAgreementRepository;
use Gourmet\Payments\Database\ProviderResourceRepository;
use Gourmet\Payments\Database\PayPalWebhookInbox;
use Gourmet\Payments\Database\SalesOsEventOutbox;
use Gourmet\Payments\Domain\Money;
use Gourmet\Payments\Domain\PaymentAgreementService;
use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Logging\Redactor;
use Gourmet\Payments\Payments\PayPal\CurlPayPalHttpTransport;
use Gourmet\Payments\Payments\PayPal\PayPalClient;
use Gourmet\Payments\Payments\PayPal\PayPalConfig;
use Gourmet\Payments\Payments\PayPal\PayPalProvisioningService;
use Gourmet\Payments\Payments\PayPal\PayPalReconciler;
use Gourmet\Payments\Security\Csrf;
use Gourmet\Payments\Security\InternalApiAuthenticator;
use Gourmet\Payments\Security\PaymentLinkReplayCipher;
use Gourmet\Payments\Security\Secrets;
use Gourmet\Payments\Security\SecurityHeaders;
use Gourmet\Payments\Support\Config;
use Gourmet\Payments\Support\Env;
use PDO;

final readonly class Application
{
    /** @var list<string> */
    private const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix'];

    public function __construct(private Config $config, private JsonLogger $logger)
    {
    }

    public function handle(Request $request): Response
    {
        $requestId = bin2hex(random_bytes(16));
        try {
            $response = $this->dispatch($request, $requestId);
        } catch (\Throwable $exception) {
            $this->logger->log('error', 'http.unhandled_exception', [
                'request_id' => $requestId,
                'method' => $request->method,
                'path' => Redactor::path($request->path),
                'exception_class' => $exception::class,
            ]);
            $response = $request->path === '/health'
                ? Response::json(['status' => 'error', 'environment' => $this->config->environment, 'database' => 'error'], 503)
                : Response::html(Html::page('Service unavailable', '<section class="card"><h1>Service temporarily unavailable</h1><p>Please try again later.</p></section>'), 503);
        }

        return $response->withHeaders(array_merge(SecurityHeaders::baseline($request->https), ['X-Request-ID' => $requestId]));
    }

    private function dispatch(Request $request, string $requestId): Response
    {
        if ($request->method === 'GET' && $request->path === '/') {
            return Response::redirect('/admin');
        }
        if ($request->method === 'GET' && $request->path === '/health') {
            return $this->health();
        }
        if ($request->method === 'POST' && $request->path === '/webhooks/paypal') {
            return $this->paypalWebhook($request, $requestId);
        }
        if ($request->path === '/internal/v1/payment-agreements') {
            return $this->internalPaymentAgreement($request, $requestId);
        }
        if ($request->path === '/admin/login') {
            return $request->method === 'POST' ? $this->login($request, $requestId) : $this->loginForm();
        }
        if (preg_match('#^/admin/bootstrap/([a-f0-9]{32})$#i', $request->path, $matches)) {
            return $request->method === 'POST'
                ? $this->bootstrapAdmin($request, $requestId, $matches[1])
                : $this->bootstrapForm($matches[1]);
        }
        if ($request->method === 'GET' && $request->path === '/admin') {
            return $this->adminDashboard($request);
        }
        if ($request->method === 'GET' && $request->path === '/admin/agreements') {
            return $this->agreementsIndex($request);
        }
        if ($request->method === 'GET' && $request->path === '/admin/agreements/new') {
            return $this->newAgreementForm($request);
        }
        if ($request->method === 'POST' && $request->path === '/admin/agreements') {
            return $this->createAgreement($request, $requestId);
        }
        if ($request->method === 'POST' && preg_match('#^/admin/agreements/([0-9a-f-]{36})/revoke$#i', $request->path, $matches)) {
            return $this->revokeLink($request, $requestId, $matches[1]);
        }
        if ($request->method === 'POST' && preg_match('#^/admin/agreements/([0-9a-f-]{36})/replace$#i', $request->path, $matches)) {
            return $this->replaceLink($request, $requestId, $matches[1]);
        }
        if ($request->method === 'GET' && preg_match('#^/admin/agreements/([0-9a-f-]{36})$#i', $request->path, $matches)) {
            return $this->agreementDetail($request, $matches[1]);
        }
        if ($request->method === 'POST' && $request->path === '/admin/logout') {
            return $this->logout($request, $requestId);
        }
        if (preg_match('#^/pay/([A-Za-z0-9_-]{43})/status$#', $request->path, $matches) && $request->method === 'GET') {
            return $this->paymentStatus($matches[1]);
        }
        if (preg_match('#^/pay/([A-Za-z0-9_-]{43})/paypal$#', $request->path, $matches) && $request->method === 'POST') {
            return $this->startPayPal($request, $matches[1]);
        }
        if ($request->method === 'GET' && preg_match('#^/pay/([A-Za-z0-9_-]{43})$#', $request->path, $matches)) {
            return $this->paymentLink($matches[1]);
        }

        return Response::html(Html::page('Not found', '<section class="card"><h1>Page not found</h1></section>'), 404);
    }

    private function health(): Response
    {
        try {
            $database = (int) $this->pdo()->query('SELECT 1')->fetchColumn() === 1 ? 'ok' : 'error';
        } catch (\Throwable) {
            $database = 'error';
        }
        return Response::json(['status' => $database === 'ok' ? 'ok' : 'degraded', 'environment' => $this->config->environment, 'database' => $database], $database === 'ok' ? 200 : 503);
    }

    private function paymentLink(string $token, ?string $error = null): Response
    {
        $agreement = $this->repository()->findUsableByRawToken($token, $this->now());
        if ($agreement === null) {
            return $this->unavailableLinkForToken($token);
        }
        if (in_array((string) $agreement['status'], ['RESERVATION_PAID', 'FULLY_PAID', 'PAYMENT_FAILED'], true)) {
            return Response::redirect('/pay/' . rawurlencode($token) . '/status');
        }

        $csrf = Csrf::issue();
        $errorHtml = $error === null ? '' : '<p class="error" role="alert">' . Html::escape($error) . '</p>';
        $checkoutActivationPending = $this->checkoutActivationPending();
        $balanceDate = $this->businessDate((string) $agreement['balance_due_at_utc'], (string) $agreement['balance_timezone']);
        $event = $agreement['event_at_utc'] === null ? '' : '<p class="event-meta">' . Html::escape($this->businessDate((string) $agreement['event_at_utc'], (string) $agreement['balance_timezone'])) . '</p>';
        $service = '<p class="event-name">' . Html::escape((string) $agreement['service_name']) . '</p>' . $event;
        $html = '<section class="checkout-hero"><p class="kicker">Secure your reservation</p><h1>Reserve your date with confidence.</h1><p class="lead">Hello ' . Html::escape((string) $agreement['recipient_name']) . ', your payment plan is ready.</p></section>' .
            '<section class="checkout-grid"><div class="checkout-main"><article class="service-card">' . $service . '</article>' .
            '<article class="disclosure"><h2>What you’re approving</h2><ul><li><strong>' . $this->money((int) $agreement['reservation_cents']) . '</strong> is due today through PayPal.</li><li>Your reservation fee is <strong>non-refundable</strong> and applies toward your total service price.</li><li>PayPal will automatically charge <strong>' . $this->money((int) $agreement['balance_cents']) . '</strong> once on <strong>' . Html::escape($balanceDate) . '</strong>.</li></ul></article></div>' .
            '<aside class="payment-summary"><span class="eyebrow">Payment summary</span><dl class="money-list"><div><dt>Total service</dt><dd>' . $this->money((int) $agreement['total_cents']) . '</dd></div><div class="due"><dt>Due today</dt><dd>' . $this->money((int) $agreement['reservation_cents']) . '</dd></div><div><dt>Remaining balance</dt><dd>' . $this->money((int) $agreement['balance_cents']) . '</dd></div><div><dt>Automatic balance charge</dt><dd>' . Html::escape($balanceDate) . '</dd></div></dl>' .
            $errorHtml . ($checkoutActivationPending
                ? '<section class="activation-pending" role="status"><span class="eyebrow">Payments are being activated</span><h2>Your payment link is ready.</h2><p>We are completing a final secure-payment activation. Please return to this link shortly; no payment has been started.</p></section>'
                : '<form method="post" action="/pay/' . Html::escape($token) . '/paypal" class="checkout-form"><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><label class="consent"><input type="checkbox" name="consent" value="yes" required><span>I understand that the ' . $this->money((int) $agreement['reservation_cents']) . ' reservation fee is non-refundable and will be applied toward my total. I authorize Gourmet Corporation to automatically charge the remaining balance of ' . $this->money((int) $agreement['balance_cents']) . ' on ' . Html::escape($balanceDate) . ' through PayPal.</span></label><p class="fine-print">PayPal may describe this authorization as a subscription. Your Gourmet agreement includes only one future balance payment of ' . $this->money((int) $agreement['balance_cents']) . ' on ' . Html::escape($balanceDate) . '. You will not be charged daily, monthly, or for any additional recurring payments.</p><button type="submit" class="paypal-button">Pay $49 with PayPal <span>→</span></button></form>') . '</aside></section>';

        return Response::html(Html::page('Secure your reservation', $html))->withCookie('gp_checkout_csrf', $csrf, time() + 1800, true);
    }

    private function startPayPal(Request $request, string $token): Response
    {
        $agreement = $this->repository()->findUsableByRawToken($token, $this->now());
        if ($agreement === null) {
            return $this->unavailableLinkForToken($token);
        }
        if ($this->checkoutActivationPending()) {
            return $this->paymentLink($token);
        }
        if (!Csrf::validate($request->post['csrf_token'] ?? '', $request->cookies['gp_checkout_csrf'] ?? '') || ($request->post['consent'] ?? '') !== 'yes') {
            return $this->paymentLink($token, 'Please review and accept the payment authorization before continuing.');
        }
        if (in_array((string) $agreement['status'], ['RESERVATION_PAID', 'FULLY_PAID'], true)) {
            return Response::redirect('/pay/' . rawurlencode($token) . '/status');
        }

        try {
            $this->assertPayPalCheckoutAllowed();
            $this->repository()->recordCheckoutConsents(
                $agreement,
                Secrets::privacyHash($request->ipAddress, $this->config->appKey),
                $request->userAgent,
            );
            $paypal = new PayPalClient($this->paypalConfig(), new CurlPayPalHttpTransport());
            $provisioner = new PayPalProvisioningService($this->pdo(), $paypal, new ProviderResourceRepository($this->pdo()), new IdempotencyGuard($this->pdo()));
            $product = $provisioner->createOrReuseProduct();
            $plan = $provisioner->createOrReusePlan($product->externalId, (int) $agreement['balance_cents']);
            $subscription = $provisioner->createOrReuseSubscription(
                (int) $agreement['id'],
                (string) $agreement['public_uuid'],
                $plan->externalId,
                new \DateTimeImmutable((string) $agreement['balance_due_at_utc'], new \DateTimeZone('UTC')),
            );
            if ($subscription->approvalUrl !== null) {
                return Response::redirect($subscription->approvalUrl);
            }
            return Response::redirect('/pay/' . rawurlencode($token) . '/status');
        } catch (\Throwable $exception) {
            $this->logger->log('warning', 'checkout.paypal_provisioning_unavailable', ['exception_class' => $exception::class]);
            return $this->paymentLink($token, 'We could not start PayPal securely. Please wait a moment and check your payment status before trying again.');
        }
    }

    private function paymentStatus(string $token): Response
    {
        $agreement = $this->repository()->findUsableByRawToken($token, $this->now());
        if ($agreement === null) {
            return $this->unavailableLinkForToken($token);
        }
        if (is_string($agreement['paypal_subscription_id']) && $agreement['paypal_subscription_id'] !== '') {
            try {
                $this->assertPayPalOperational();
                (new PayPalReconciler($this->pdo(), new PayPalClient($this->paypalConfig(), new CurlPayPalHttpTransport()), new ProviderResourceRepository($this->pdo())))
                    ->reconcile((string) $agreement['public_uuid'], (string) $agreement['paypal_subscription_id']);
                $agreement = $this->repository()->findUsableByRawToken($token, $this->now()) ?? $agreement;
            } catch (\Throwable $exception) {
                $this->logger->log('warning', 'checkout.paypal_status_pending', ['exception_class' => $exception::class]);
            }
        }

        $balanceDate = $this->businessDate((string) $agreement['balance_due_at_utc'], (string) $agreement['balance_timezone']);
        if (in_array((string) $agreement['status'], ['RESERVATION_PAID', 'FULLY_PAID'], true)) {
            $content = '<section class="status-card success"><span class="eyebrow">Reservation confirmed</span><h1>Your date is reserved.</h1><p class="lead">' . $this->money((int) $agreement['reservation_cents']) . ' has been confirmed through PayPal.</p><dl class="money-list"><div><dt>Remaining balance</dt><dd>' . $this->money((int) $agreement['balance_cents']) . '</dd></div><div><dt>Scheduled charge date</dt><dd>' . Html::escape($balanceDate) . '</dd></div><div><dt>Payment method</dt><dd>PayPal</dd></div></dl><p>No further action is required at this time.</p><p class="reference">Agreement reference: ' . Html::escape(substr((string) $agreement['public_uuid'], 0, 8)) . '</p></section>';
        } elseif ((string) $agreement['status'] === 'PAYMENT_FAILED') {
            $content = '<section class="status-card"><span class="eyebrow">Payment needs attention</span><h1>We couldn’t confirm your reservation payment.</h1><p>Please do not submit another payment. We have kept your agreement intact and will reconcile PayPal before any further action.</p><a class="button secondary-link" href="/pay/' . Html::escape($token) . '/status">Check payment status</a></section>';
        } elseif (($agreement['paypal_subscription_id'] ?? null) !== null) {
            $content = '<section class="status-card"><span class="eyebrow">Confirming your reservation</span><h1>We’re confirming your payment.</h1><p>Please do not submit another payment. This page checks PayPal’s financial record and will update after confirmation.</p><a class="button secondary-link" href="/pay/' . Html::escape($token) . '/status">Check payment status</a></section>';
        } else {
            return $this->paymentLink($token);
        }
        return Response::html(Html::page('Payment status', $content));
    }

    private function unavailableLink(): Response
    {
        return Response::html(Html::page('Payment agreement unavailable', '<section class="status-card"><span class="eyebrow">Payment link unavailable</span><h1>This payment link is unavailable.</h1><p>It may have expired or been replaced. Please contact Gourmet Corporation for assistance.</p></section>'), 404);
    }

    private function unavailableLinkForToken(string $token): Response
    {
        $pdo = $this->pdo();
        try {
            $pdo->beginTransaction();
            $expired = $this->repository()->recordExpirationByRawToken($token, $this->now());
            if ($expired !== null) {
                (new SalesOsEventOutbox($pdo))->enqueueAgreementEvent(
                    $expired,
                    'payment_link.expired',
                    'payment_link.expired:' . (string) $expired['public_uuid'],
                );
            }
            $pdo->commit();
        } catch (\Throwable $exception) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $this->logger->log('warning', 'payment_link.expiration_event_unavailable', ['exception_class' => $exception::class]);
        }
        return $this->unavailableLink();
    }

    private function paypalWebhook(Request $request, string $requestId): Response
    {
        try {
            $this->assertPayPalOperational();
            $event = (new PayPalClient($this->paypalConfig(), new CurlPayPalHttpTransport()))
                ->verifyWebhook($request->rawBody, $request->headers);
            $accepted = (new PayPalWebhookInbox($this->pdo()))->accept($event);
            $this->logger->log('info', $accepted ? 'paypal.webhook_received' : 'paypal.webhook_duplicate', [
                'request_id' => $requestId,
                'event_type' => $event->eventType,
            ]);
            return Response::json(['status' => 'accepted'], 202);
        } catch (\Throwable $exception) {
            $this->logger->log('warning', 'paypal.webhook_rejected', [
                'request_id' => $requestId,
                'exception_class' => $exception::class,
            ]);
            return Response::json(['status' => 'rejected'], 400);
        }
    }

    private function internalPaymentAgreement(Request $request, string $requestId): Response
    {
        if (!$this->internalApiEnabled() || !InternalApiAuthenticator::validBearer($request->headers['authorization'] ?? null, $this->internalApiSharedSecret())) {
            return Response::json(['status' => 'not_found'], 404);
        }
        if ($request->method !== 'POST') {
            return Response::json(['status' => 'method_not_allowed'], 405)->withHeaders(['Allow' => 'POST']);
        }
        if (!str_starts_with(mb_strtolower($request->headers['content-type'] ?? ''), 'application/json')) {
            return Response::json(['status' => 'invalid_request'], 415);
        }

        $idempotencyKey = trim($request->headers['idempotency-key'] ?? '');
        if (preg_match('/\A[A-Za-z0-9._:-]{16,255}\z/', $idempotencyKey) !== 1) {
            return Response::json(['status' => 'invalid_request'], 400);
        }

        try {
            $command = InternalPaymentAgreementRequest::fromJson($request->rawBody);
        } catch (\DomainException) {
            return Response::json(['status' => 'invalid_request'], 422);
        }

        $scope = 'internal.payment_agreements.create.v1';
        try {
            $cipher = $this->paymentLinkReplayCipher();
        } catch (\Throwable $exception) {
            $this->logger->log('warning', 'internal.payment_agreement_replay_unavailable', ['request_id' => $requestId, 'exception_class' => $exception::class]);
            return Response::json(['status' => 'request_unavailable'], 503);
        }
        try {
            $guard = new IdempotencyGuard($this->pdo());
            $replay = $guard->replay($scope, $idempotencyKey, $command->requestHash());
            if ($replay !== null) {
                $response = json_decode($cipher->decrypt($replay['ciphertext'], $replay['nonce'], $replay['tag']), true, 16, JSON_THROW_ON_ERROR);
                if (!is_array($response) || !isset($response['payment_agreement_id'], $response['public_payment_url'], $response['status'])) {
                    throw new \RuntimeException('Stored idempotency response is invalid.');
                }
                return Response::json($response, 200);
            }
            $guard->begin($scope, $idempotencyKey, $command->requestHash());
        } catch (\DomainException | \RuntimeException) {
            return Response::json(['status' => 'idempotency_conflict'], 409);
        } catch (\Throwable $exception) {
            $this->logger->log('warning', 'internal.payment_agreement_request_rejected', ['request_id' => $requestId, 'exception_class' => $exception::class]);
            return Response::json(['status' => 'request_unavailable'], 503);
        }

        try {
            $timezone = $this->internalTimezone($command->timezone);
            $balanceDue = $this->localDate($command->balanceDueDate, $timezone);
            $eventAt = $command->eventAt === null ? null : $this->localDate($command->eventAt, $timezone);
            $expires = $this->internalExpiration($command->linkExpiration, $timezone);
            $response = null;
            $agreement = (new PaymentAgreementService($this->pdo()))->create(
                $command->mondayItemId,
                $command->recipientName,
                $command->recipientEmail,
                $command->totalCents,
                $balanceDue,
                $timezone,
                $expires,
                'PAYPAL',
                $command->recipientPhone,
                $command->serviceName,
                $eventAt,
                $command->eventLocation,
                null,
                $command->leadId,
                $command->quoteId,
                $command->quoteVersion,
                function (string $agreementUuid, string $token) use (&$response, $expires, $cipher, $guard, $scope, $idempotencyKey): void {
                    $response = [
                        'payment_agreement_id' => $agreementUuid,
                        'public_payment_url' => $this->linkUrl($token),
                        'expires_at' => $expires?->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z'),
                        'status' => 'PENDING_RESERVATION',
                    ];
                    $json = json_encode($response, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
                    $encrypted = $cipher->encrypt($json);
                    $guard->completeEncrypted($scope, $idempotencyKey, 201, hash('sha256', $json, true), $encrypted['ciphertext'], $encrypted['nonce'], $encrypted['tag']);
                },
            );
            if (!is_array($response)) {
                throw new \RuntimeException('Payment-link response was not recorded.');
            }
            (new AuditLog($this->pdo()))->record('INTERNAL_API', 'PAYMENT_LINK_REQUESTED', 'PAYMENT_AGREEMENT', null, $agreement['agreement_uuid'], $requestId, [
                'lead_id' => $command->leadId,
                'quote_id' => $command->quoteId,
                'quote_version' => $command->quoteVersion,
            ]);
            return Response::json($response, 201);
        } catch (\DomainException) {
            $guard->releaseDefinitiveFailure($scope, $idempotencyKey);
            return Response::json(['status' => 'invalid_request'], 422);
        } catch (\Throwable $exception) {
            $guard->markAmbiguous($scope, $idempotencyKey);
            $this->logger->log('error', 'internal.payment_agreement_request_failed', ['request_id' => $requestId, 'exception_class' => $exception::class]);
            return Response::json(['status' => 'request_unavailable'], 503);
        }
    }

    private function loginForm(?string $error = null): Response
    {
        $csrf = Csrf::issue();
        $message = $error === null ? '' : '<p class="error" role="alert">' . Html::escape($error) . '</p>';
        $html = '<section class="auth-card"><span class="eyebrow">Internal access</span><h1>Gourmet Payments</h1><p>Sign in to manage private payment links.</p>' . $message .
            '<form method="post" action="/admin/login"><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></section>';
        return Response::html(Html::page('Admin sign in', $html))->withCookie('gp_login_csrf', $csrf, time() + 900, true);
    }

    private function login(Request $request, string $requestId): Response
    {
        if (!Csrf::validate($request->post['csrf_token'] ?? '', $request->cookies['gp_login_csrf'] ?? '')) {
            return $this->loginForm('Unable to sign in.');
        }
        $session = $this->auth()->login($request->post['email'] ?? '', $request->post['password'] ?? '', $request->ipAddress, $request->userAgent);
        if ($session === null) {
            return $this->loginForm('Unable to sign in.');
        }
        (new AuditLog($this->pdo()))->record('ADMIN', 'ADMIN_LOGIN_SUCCEEDED', 'ADMIN_SESSION', null, null, $requestId);
        return Response::redirect('/admin')->withCookie('gp_admin_session', $session['raw_token'], strtotime($session['expires_at'] . ' UTC'), true)->withCookie('gp_csrf', $session['csrf_token'], strtotime($session['expires_at'] . ' UTC'), true);
    }

    private function bootstrapForm(string $publicId, ?string $error = null): Response
    {
        if (!(new AdminBootstrap($this->pdo()))->isAvailable($publicId)) {
            return $this->bootstrapUnavailable();
        }

        $csrf = Csrf::issue();
        $message = $error === null ? '' : '<p class="error" role="alert">' . Html::escape($error) . '</p>';
        $html = '<section class="auth-card"><span class="eyebrow">One-time setup</span><h1>Secure administrator setup</h1><p id="bootstrap-status">Open this page only from its secure setup link.</p>' . $message .
            '<form id="admin-bootstrap-form" data-admin-bootstrap-form method="post" action="/admin/bootstrap/' . Html::escape($publicId) . '" hidden><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><input type="hidden" name="bootstrap_token" value=""><label>Name<input name="display_name" autocomplete="name" required maxlength="120"></label><label>Email<input name="email" type="email" autocomplete="username" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="14" required></label><label>Confirm password<input name="password_confirmation" type="password" autocomplete="new-password" minlength="14" required></label><button type="submit">Create administrator</button></form></section>';

        return Response::html(Html::page('Secure administrator setup', $html))->withCookie('gp_bootstrap_csrf', $csrf, time() + 3600, true);
    }

    private function bootstrapAdmin(Request $request, string $requestId, string $publicId): Response
    {
        if (!Csrf::validate($request->post['csrf_token'] ?? '', $request->cookies['gp_bootstrap_csrf'] ?? '')) {
            return $this->bootstrapUnavailable();
        }
        if (!hash_equals($request->post['password'] ?? '', $request->post['password_confirmation'] ?? '')) {
            return $this->bootstrapForm($publicId, 'Unable to create administrator.');
        }

        $created = (new AdminBootstrap($this->pdo()))->createFirstAdmin(
            $publicId,
            $request->post['bootstrap_token'] ?? '',
            $request->post['email'] ?? '',
            $request->post['display_name'] ?? '',
            $request->post['password'] ?? '',
        );
        if (!$created) {
            return $this->bootstrapUnavailable();
        }

        (new AuditLog($this->pdo()))->record('SYSTEM', 'ADMIN_BOOTSTRAP_COMPLETED', 'ADMIN_USER', null, null, $requestId);
        return Response::redirect('/admin/login')->withCookie('gp_bootstrap_csrf', '', time() - 3600, true);
    }

    private function bootstrapUnavailable(): Response
    {
        return Response::html(Html::page('Not found', '<section class="card"><h1>Page not found</h1></section>'), 404);
    }

    private function adminDashboard(Request $request): Response
    {
        if ($this->adminUser($request) === null) {
            return Response::redirect('/admin/login');
        }
        $dashboard = $this->repository()->dashboard();
        $cards = '';
        foreach (['total' => 'Total agreements', 'awaiting_reservation' => 'Awaiting reservation', 'reservation_paid' => 'Reservation paid', 'balance_scheduled' => 'Balance scheduled', 'fully_paid' => 'Fully paid', 'attention_required' => 'Attention required'] as $key => $label) {
            $cards .= '<article class="metric"><span>' . Html::escape($label) . '</span><strong>' . (int) $dashboard['counts'][$key] . '</strong></article>';
        }
        $activity = '';
        foreach ($dashboard['recent_activity'] as $row) {
            $subject = $row['recipient_name'] === null ? 'System activity' : (string) $row['recipient_name'] . ' · ' . (string) $row['service_name'];
            $activity .= '<li><strong>' . Html::escape((string) $row['event_type']) . '</strong><span>' . Html::escape($subject) . ' · ' . Html::escape((string) $row['created_at']) . '</span></li>';
        }
        if ($activity === '') { $activity = '<li><span>No operational activity yet.</span></li>'; }
        $upcoming = '';
        foreach ($dashboard['upcoming_balances'] as $row) {
            $upcoming .= '<tr><td>' . Html::escape((string) $row['recipient_name']) . '</td><td>' . $this->money((int) $row['amount_cents']) . '</td><td>' . Html::escape($this->businessDate((string) $row['due_at_utc'], (string) $row['balance_timezone'])) . '</td><td><a href="/admin/agreements/' . Html::escape((string) $row['public_uuid']) . '">Open</a></td></tr>';
        }
        if ($upcoming === '') { $upcoming = '<tr><td colspan="4">No scheduled balance charges.</td></tr>'; }
        $attention = '';
        foreach ($dashboard['attention'] as $row) {
            $attention .= '<li><a href="/admin/agreements/' . Html::escape((string) $row['public_uuid']) . '">' . Html::escape((string) $row['recipient_name']) . '</a><span>' . Html::escape((string) $row['status']) . ' · review required</span></li>';
        }
        if ($attention === '') { $attention = '<li><span>No agreements need attention.</span></li>'; }
        $content = $this->adminNav('dashboard') . '<section class="admin-heading"><div><span class="eyebrow">Operations</span><h1>Operational dashboard</h1><p>Monitor payment activity and upcoming obligations without duplicating the agreements register.</p></div><a class="button" href="/admin/agreements/new">Create payment link</a></section><section class="metric-grid">' . $cards . '</section><section class="dashboard-grid"><section class="panel"><h2>Recent activity</h2><ul class="activity-list">' . $activity . '</ul></section><section class="panel"><h2>Upcoming balance charges</h2><div class="table-wrap"><table><thead><tr><th>Client</th><th>Amount</th><th>Due date</th><th></th></tr></thead><tbody>' . $upcoming . '</tbody></table></div></section></section><section class="panel"><h2>Attention required</h2><ul class="activity-list">' . $attention . '</ul></section>';
        return Response::html(Html::page('Operational dashboard', $content));
    }

    private function agreementsIndex(Request $request): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        $search = $request->query['q'] ?? '';
        $status = $request->query['status'] ?? 'ALL';
        $linkState = $request->query['link'] ?? 'ALL';
        try {
            $agreements = $this->repository()->agreements($search, $status, $linkState);
        } catch (\DomainException) {
            $search = ''; $status = 'ALL'; $linkState = 'ALL';
            $agreements = $this->repository()->agreements($search, $status, $linkState);
        }

        $selected = static fn (string $actual, string $value): string => $actual === $value ? ' selected' : '';
        $statusOptions = '';
        foreach (['ALL' => 'All statuses', 'PENDING_RESERVATION' => 'Pending reservation', 'AWAITING_RESERVATION' => 'Awaiting reservation', 'RESERVATION_PROCESSING' => 'Reservation processing', 'RESERVATION_PAID' => 'Reservation paid', 'FULLY_PAID' => 'Fully paid', 'PAYMENT_FAILED' => 'Payment failed', 'CANCELLED' => 'Cancelled'] as $value => $label) {
            $statusOptions .= '<option value="' . Html::escape($value) . '"' . $selected($status, $value) . '>' . Html::escape($label) . '</option>';
        }
        $linkOptions = '';
        foreach (['ALL' => 'All link states', 'ACTIVE' => 'Active', 'EXPIRED' => 'Expired', 'REVOKED' => 'Revoked'] as $value => $label) {
            $linkOptions .= '<option value="' . Html::escape($value) . '"' . $selected($linkState, $value) . '>' . Html::escape($label) . '</option>';
        }
        $rows = '';
        foreach ($agreements as $agreement) {
            $rows .= '<tr><td>' . Html::escape((string) $agreement['recipient_name']) . '</td><td>' . Html::escape((string) $agreement['service_name']) . '</td><td>' . $this->money((int) $agreement['total_cents']) . '</td><td>' . $this->money((int) $agreement['balance_cents']) . '</td><td>' . Html::escape($this->businessDate((string) $agreement['balance_due_at_utc'], (string) $agreement['balance_timezone'])) . '</td><td><span class="status">' . Html::escape((string) $agreement['status']) . '</span></td><td>' . Html::escape($this->linkStatus($agreement)) . '</td><td><a href="/admin/agreements/' . Html::escape((string) $agreement['public_uuid']) . '">View</a></td></tr>';
        }
        if ($rows === '') { $rows = '<tr><td colspan="8">No agreements match these filters.</td></tr>'; }
        $content = $this->adminNav('agreements') . '<section class="admin-heading"><div><span class="eyebrow">Agreement register</span><h1>Payment agreements</h1><p>Search and filter the complete payment-agreement register.</p></div><a class="button" href="/admin/agreements/new">Create payment link</a></section><form method="get" action="/admin/agreements" class="agreement-filters"><label>Search<input name="q" value="' . Html::escape($search) . '" placeholder="Client, email, service, Monday reference or agreement"></label><label>Status<select name="status">' . $statusOptions . '</select></label><label>Link state<select name="link">' . $linkOptions . '</select></label><button type="submit">Apply filters</button></form><section class="panel"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Service</th><th>Total</th><th>Balance</th><th>Balance date</th><th>Status</th><th>Link</th><th></th></tr></thead><tbody>' . $rows . '</tbody></table></div></section>';
        return Response::html(Html::page('Payment agreements', $content));
    }

    private function newAgreementForm(Request $request, ?string $error = null, array $values = []): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        $csrf = $request->cookies['gp_csrf'] ?? '';
        $tzOptions = '';
        foreach (self::TIMEZONES as $timezone) {
            $selected = ($values['timezone'] ?? 'America/New_York') === $timezone ? ' selected' : '';
            $tzOptions .= '<option value="' . Html::escape($timezone) . '"' . $selected . '>' . Html::escape($timezone) . '</option>';
        }
        $value = static fn (string $key): string => Html::escape((string) ($values[$key] ?? ''));
        $message = $error === null ? '' : '<p class="error" role="alert">' . Html::escape($error) . '</p>';
        $content = $this->adminNav('new') . '<section class="admin-heading"><div><span class="eyebrow">Create payment link</span><h1>Set the agreement once.</h1><p>PayPal is provisioned only after the customer explicitly consents.</p></div></section>' . $message .
            '<form method="post" action="/admin/agreements" class="agreement-form"><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><fieldset><legend>Monday client reference</legend><label>Monday client reference<input name="monday_reference" type="url" inputmode="url" placeholder="https://your-team.monday.com/boards/.../pulses/..." value="' . $value('monday_reference') . '" required></label><p class="field-note">Paste the client’s Monday item link. Gourmet extracts and stores the item reference; a searchable selector will be available once Monday is connected.</p><div class="two-col"><label>Recipient name<input name="recipient_name" value="' . $value('recipient_name') . '" required></label><label>Email<input name="email" type="email" value="' . $value('email') . '" required></label></div><label>Phone <span class="optional">optional</span><input name="phone" type="tel" value="' . $value('phone') . '"></label></fieldset><fieldset><legend>Service / event</legend><label>Event or service name<input name="service_name" value="' . $value('service_name') . '" required></label><div class="two-col"><label>Event date <span class="optional">optional</span><input name="event_at" type="datetime-local" value="' . $value('event_at') . '"></label><label>Event location <span class="optional">optional</span><input name="event_location" value="' . $value('event_location') . '"></label></div><label>Internal description / notes <span class="optional">optional</span><textarea name="internal_notes">' . $value('internal_notes') . '</textarea></label></fieldset><fieldset><legend>Payment</legend><div class="two-col"><label>Total service amount in USD<input name="total_amount" inputmode="decimal" placeholder="1500.00" value="' . $value('total_amount') . '" required></label><label>Reservation fee<input value="$49.00" readonly aria-readonly="true"></label></div><p class="field-note">Remaining balance is calculated server-side as total minus $49.00.</p><div class="two-col"><label>Balance automatic charge date<input name="balance_due_at" type="datetime-local" value="' . $value('balance_due_at') . '" required></label><label>Business timezone<select name="timezone">' . $tzOptions . '</select></label></div></fieldset><fieldset><legend>Payment link</legend><div class="two-col"><label>Expiration<select name="expiration"><option value="7d">7 days</option><option value="24h">24 hours</option><option value="48h">48 hours</option><option value="72h">72 hours</option><option value="custom">Custom</option><option value="never">Never</option></select></label><label>Custom expiration <span class="optional">if selected</span><input name="custom_expiration" type="datetime-local"></label></div><p class="field-note">Provider: PayPal.</p></fieldset><button type="submit">Create payment link</button></form>';
        return Response::html(Html::page('Create payment link', $content));
    }

    private function createAgreement(Request $request, string $requestId): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        if (!$this->auth()->validateCsrf($request->cookies['gp_admin_session'] ?? '', $request->post['csrf_token'] ?? '')) {
            return Response::html(Html::page('Invalid request', '<section class="card"><h1>Invalid request</h1></section>'), 403);
        }
        try {
            $timezone = $this->timezone($request->post['timezone'] ?? '');
            $balanceDue = $this->localDate($request->post['balance_due_at'] ?? '', $timezone);
            $eventAt = ($request->post['event_at'] ?? '') === '' ? null : $this->localDate($request->post['event_at'] ?? '', $timezone);
            $expires = $this->expiration($request->post['expiration'] ?? '7d', $request->post['custom_expiration'] ?? '', $timezone);
            $agreement = (new PaymentAgreementService($this->pdo()))->create(
                $request->post['monday_reference'] ?? '', $request->post['recipient_name'] ?? '', $request->post['email'] ?? '', $this->cents($request->post['total_amount'] ?? ''),
                $balanceDue, $timezone, $expires, 'PAYPAL', $request->post['phone'] ?? null, $request->post['service_name'] ?? '', $eventAt,
                $request->post['event_location'] ?? null, $request->post['internal_notes'] ?? null,
            );
            (new AuditLog($this->pdo()))->record('ADMIN', 'PAYMENT_LINK_CREATED', 'PAYMENT_AGREEMENT', null, $agreement['agreement_uuid'], $requestId);
            return $this->linkCreated($agreement, $expires);
        } catch (\Throwable $exception) {
            return $this->newAgreementForm($request, 'Please review the required fields and future payment dates.', $request->post);
        }
    }

    /** @param array{agreement_uuid:string,token:string} $created */
    private function linkCreated(array $created, ?\DateTimeImmutable $expires): Response
    {
        $link = $this->linkUrl($created['token']);
        $content = $this->adminNav('new') . '<section class="status-card success"><span class="eyebrow">Payment link created</span><h1>Ready to share securely.</h1><p>The raw link is shown only now. Gourmet stores only its hash.</p><label class="copy-field">Customer payment link<input id="payment-link" value="' . Html::escape($link) . '" readonly></label><div class="button-row"><button type="button" data-copy-target="payment-link">Copy link</button><a class="button secondary-link" href="' . Html::escape($link) . '" target="_blank" rel="noreferrer">Open checkout</a></div><dl class="money-list"><div><dt>Agreement reference</dt><dd>' . Html::escape(substr($created['agreement_uuid'], 0, 8)) . '</dd></div><div><dt>Expiration</dt><dd>' . Html::escape($expires === null ? 'Never' : $expires->format('F j, Y g:i A T')) . '</dd></div></dl><a href="/admin/agreements/' . Html::escape($created['agreement_uuid']) . '">View agreement</a></section>';
        return Response::html(Html::page('Payment link created', $content));
    }

    private function agreementDetail(Request $request, string $uuid): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        $agreement = $this->repository()->findByPublicUuid($uuid);
        if ($agreement === null) { return Response::html(Html::page('Not found', '<section class="card"><h1>Agreement not found</h1></section>'), 404); }
        $schedules = $this->repository()->schedules((int) $agreement['id']);
        $attempts = $this->repository()->attempts((int) $agreement['id']);
        $consents = $this->repository()->consents((int) $agreement['id']);
        $audits = $this->repository()->audits((int) $agreement['id'], $uuid);
        $csrf = $request->cookies['gp_csrf'] ?? '';
        $notes = $agreement['internal_notes'] === null ? '' : '<p><strong>Internal notes</strong><br>' . nl2br(Html::escape((string) $agreement['internal_notes'])) . '</p>';
        $linkActions = $agreement['paypal_subscription_id'] === null
            ? '<aside class="panel"><span class="eyebrow">Link management</span><h2>Customer checkout</h2><p>Financial terms lock after reservation payment. A provisioned PayPal approval flow also locks this link to prevent duplicate payment operations.</p><form method="post" action="/admin/agreements/' . Html::escape($uuid) . '/replace"><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><button type="submit" class="secondary">Generate replacement link</button></form><form method="post" action="/admin/agreements/' . Html::escape($uuid) . '/revoke"><input type="hidden" name="csrf_token" value="' . Html::escape($csrf) . '"><button type="submit" class="danger">Revoke payment link</button></form></aside>'
            : '<aside class="panel"><span class="eyebrow">Link management</span><h2>Customer checkout</h2><p>This link is locked because PayPal provisioning has started. Reconcile the existing provider state before any future operational decision.</p></aside>';
        $detail = '<section class="detail-grid"><article class="panel"><span class="eyebrow">Payment snapshot</span><h1>' . Html::escape((string) $agreement['service_name']) . '</h1><p>Monday client reference<br>' . Html::escape((string) $agreement['recipient_name']) . '<br>' . Html::escape((string) $agreement['recipient_email']) . ($agreement['recipient_phone'] === null ? '' : '<br>' . Html::escape((string) $agreement['recipient_phone'])) . '</p>' . $notes . '<dl class="money-list"><div><dt>Total</dt><dd>' . $this->money((int) $agreement['total_cents']) . '</dd></div><div><dt>Reservation</dt><dd>' . $this->money((int) $agreement['reservation_cents']) . '</dd></div><div><dt>Balance</dt><dd>' . $this->money((int) $agreement['balance_cents']) . '</dd></div><div><dt>Balance date</dt><dd>' . Html::escape($this->businessDate((string) $agreement['balance_due_at_utc'], (string) $agreement['balance_timezone'])) . '</dd></div><div><dt>Link status</dt><dd>' . Html::escape($this->linkStatus($agreement)) . '</dd></div><div><dt>PayPal status</dt><dd>' . Html::escape((string) ($agreement['paypal_status'] ?? 'Not provisioned')) . '</dd></div><div><dt>Agreement status</dt><dd>' . Html::escape((string) $agreement['status']) . '</dd></div></dl></article>' .
            $linkActions . '</section>';
        $content = $this->adminNav('agreements') . '<section class="admin-heading"><div><span class="eyebrow">Agreement detail</span><h1>Payment agreement</h1><p>Reference ' . Html::escape(substr($uuid, 0, 8)) . '</p></div></section>' . $detail . $this->detailTable('Schedules', $schedules, ['kind' => 'Type', 'amount_cents' => 'Amount', 'due_at_utc' => 'Due', 'status' => 'Status', 'paid_at' => 'Paid']) . $this->detailTable('Payment attempts', $attempts, ['provider' => 'Provider', 'provider_payment_id' => 'Transaction', 'amount_cents' => 'Amount', 'status' => 'Status', 'created_at' => 'Created']) . $this->detailTable('Consent status', $consents, ['consent_type' => 'Consent', 'provider' => 'Provider', 'amount_cents' => 'Amount', 'scheduled_charge_at' => 'Scheduled charge', 'accepted_at' => 'Accepted']) . $this->detailTable('Audit timeline', $audits, ['event_type' => 'Event', 'actor_type' => 'Actor', 'created_at' => 'Time']);
        return Response::html(Html::page('Agreement detail', $content));
    }

    private function revokeLink(Request $request, string $requestId, string $uuid): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        if (!$this->auth()->validateCsrf($request->cookies['gp_admin_session'] ?? '', $request->post['csrf_token'] ?? '')) { return Response::html(Html::page('Invalid request', '<section class="card"><h1>Invalid request</h1></section>'), 403); }
        $agreement = $this->repository()->findByPublicUuid($uuid);
        if ($agreement !== null) {
            $pdo = $this->pdo();
            $pdo->beginTransaction();
            try {
                if ($this->repository()->revokeLink((int) $agreement['id'])) {
                    (new AuditLog($pdo))->record('ADMIN', 'PAYMENT_LINK_REVOKED', 'PAYMENT_AGREEMENT', null, $uuid, $requestId);
                    (new SalesOsEventOutbox($pdo))->enqueueAgreementEvent(
                        $agreement,
                        'payment_link.revoked',
                        'payment_link.revoked:' . $uuid,
                    );
                }
                $pdo->commit();
            } catch (\Throwable) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            }
        }
        return Response::redirect('/admin/agreements/' . rawurlencode($uuid));
    }

    private function replaceLink(Request $request, string $requestId, string $uuid): Response
    {
        if ($this->adminUser($request) === null) { return Response::redirect('/admin/login'); }
        if (!$this->auth()->validateCsrf($request->cookies['gp_admin_session'] ?? '', $request->post['csrf_token'] ?? '')) { return Response::html(Html::page('Invalid request', '<section class="card"><h1>Invalid request</h1></section>'), 403); }
        $agreement = $this->repository()->findByPublicUuid($uuid);
        if ($agreement === null) { return Response::html(Html::page('Not found', '<section class="card"><h1>Agreement not found</h1></section>'), 404); }
        try {
            $expires = $this->now()->modify('+7 days');
            $token = $this->repository()->replaceLink((int) $agreement['id'], $expires);
            (new AuditLog($this->pdo()))->record('ADMIN', 'PAYMENT_LINK_REPLACED', 'PAYMENT_AGREEMENT', null, $uuid, $requestId);
            return $this->linkCreated(['agreement_uuid' => $uuid, 'token' => $token], $expires);
        } catch (\Throwable) {
            return Response::redirect('/admin/agreements/' . rawurlencode($uuid));
        }
    }

    private function logout(Request $request, string $requestId): Response
    {
        $session = $request->cookies['gp_admin_session'] ?? '';
        if (!$this->auth()->validateCsrf($session, $request->post['csrf_token'] ?? '')) {
            return Response::html(Html::page('Invalid request', '<section class="card"><h1>Invalid request</h1></section>'), 403);
        }
        $this->auth()->logout($session);
        (new AuditLog($this->pdo()))->record('ADMIN', 'ADMIN_LOGOUT', 'ADMIN_SESSION', null, null, $requestId);
        return Response::redirect('/admin/login')->withCookie('gp_admin_session', '', time() - 3600, true)->withCookie('gp_csrf', '', time() - 3600, true);
    }

    private function adminNav(string $active): string
    {
        return '<nav class="admin-nav" aria-label="Admin navigation"><a class="' . ($active === 'dashboard' ? 'active' : '') . '" href="/admin">Dashboard</a><a class="' . ($active === 'agreements' ? 'active' : '') . '" href="/admin/agreements">Payment agreements</a><a class="' . ($active === 'new' ? 'active' : '') . '" href="/admin/agreements/new">Create payment link</a></nav>';
    }

    /** @param list<array<string,mixed>> $rows @param array<string,string> $columns */
    private function detailTable(string $title, array $rows, array $columns): string
    {
        $head = ''; foreach ($columns as $label) { $head .= '<th>' . Html::escape($label) . '</th>'; }
        $body = '';
        foreach ($rows as $row) {
            $body .= '<tr>';
            foreach ($columns as $key => $_) {
                $value = $row[$key] ?? '—';
                $body .= '<td>' . ($key === 'amount_cents' && is_numeric($value) ? $this->money((int) $value) : Html::escape((string) ($value === null || $value === '' ? '—' : $value))) . '</td>';
            }
            $body .= '</tr>';
        }
        if ($body === '') { $body = '<tr><td colspan="' . count($columns) . '">No records yet.</td></tr>'; }
        return '<section class="panel"><h2>' . Html::escape($title) . '</h2><div class="table-wrap"><table><thead><tr>' . $head . '</tr></thead><tbody>' . $body . '</tbody></table></div></section>';
    }

    /** @param array<string,mixed> $agreement */
    private function linkStatus(array $agreement): string
    {
        if ($agreement['link_revoked_at'] !== null) { return 'Revoked'; }
        if ($agreement['link_expires_at'] === null) { return 'Active · never expires'; }
        return (new \DateTimeImmutable((string) $agreement['link_expires_at'], new \DateTimeZone('UTC'))) > $this->now() ? 'Active' : 'Expired';
    }

    private function cents(string $amount): int
    {
        $amount = trim($amount);
        if (preg_match('/\A([0-9]+)(?:\.([0-9]{1,2}))?\z/', $amount, $matches) !== 1) { throw new \DomainException('Invalid USD amount.'); }
        $cents = ((int) $matches[1] * 100) + (int) str_pad($matches[2] ?? '', 2, '0');
        Money::agreement($cents);
        return $cents;
    }

    private function timezone(string $timezone): string
    {
        if (!in_array($timezone, self::TIMEZONES, true)) { throw new \DomainException('Unsupported timezone.'); }
        return $timezone;
    }

    private function localDate(string $value, string $timezone): \DateTimeImmutable
    {
        if ($value === '') { throw new \DomainException('A future date is required.'); }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d\\TH:i', $value, new \DateTimeZone($timezone));
        $errors = \DateTimeImmutable::getLastErrors();
        if ($date === false || ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) || $date->format('Y-m-d\\TH:i') !== $value || $date <= $this->now()) {
            throw new \DomainException('A valid future date is required.');
        }
        return $date;
    }

    private function expiration(string $choice, string $custom, string $timezone): ?\DateTimeImmutable
    {
        $now = $this->now();
        return match ($choice) {
            '24h' => $now->modify('+24 hours'), '48h' => $now->modify('+48 hours'), '72h' => $now->modify('+72 hours'), '7d' => $now->modify('+7 days'),
            'never' => null, 'custom' => $this->localDate($custom, $timezone), default => throw new \DomainException('Invalid link expiration.'),
        };
    }

    private function internalTimezone(string $timezone): string
    {
        try {
            new \DateTimeZone($timezone);
        } catch (\Exception) {
            throw new \DomainException('Unsupported timezone.');
        }
        return $timezone;
    }

    private function internalExpiration(?string $value, string $timezone): ?\DateTimeImmutable
    {
        if ($value === null || trim($value) === '') {
            throw new \DomainException('link_expiration is required.');
        }
        if (in_array($value, ['24h', '48h', '72h', '7d', 'never'], true)) {
            return $this->expiration($value, '', $timezone);
        }
        return $this->localDate($value, $timezone);
    }

    private function businessDate(string $utcDate, string $timezone): string
    {
        return (new \DateTimeImmutable($utcDate, new \DateTimeZone('UTC')))->setTimezone(new \DateTimeZone($timezone))->format('F j, Y');
    }

    private function money(int $cents): string
    {
        return '$' . number_format($cents / 100, 2);
    }

    private function linkUrl(string $token): string
    {
        return $this->config->appUrl . '/pay/' . $token;
    }

    private function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
    }

    private function assertPayPalOperational(): void
    {
        $paypal = $this->paypalConfig();
        if ($paypal->missingCredentials() !== []) {
            throw new \RuntimeException('PayPal credentials are incomplete.');
        }
        if ($this->config->isProduction() && $paypal->mode !== 'live') {
            throw new \RuntimeException('Production requires PAYPAL_MODE=live.');
        }
        if (!$this->config->isProduction() && $paypal->mode !== 'sandbox') {
            throw new \RuntimeException('Non-production environments require PAYPAL_MODE=sandbox.');
        }
    }

    private function assertPayPalCheckoutAllowed(): void
    {
        $this->assertPayPalOperational();
        if ($this->checkoutActivationPending()) {
            throw new \RuntimeException('Live PayPal checkout is disabled pending an explicit launch authorization.');
        }
    }

    private function checkoutActivationPending(): bool
    {
        if (!$this->config->isProduction()) {
            return false;
        }

        $enabled = $this->paypalEnv()->get('PAYPAL_LIVE_CHECKOUT_ENABLED', 'false');
        return !in_array(mb_strtolower((string) $enabled), ['1', 'true'], true);
    }

    private function paypalConfig(): PayPalConfig
    {
        return PayPalConfig::fromEnv($this->paypalEnv());
    }

    private function paypalEnv(): Env
    {
        $hostingerConfig = dirname($this->config->root) . '/config/production.env';
        $envPath = $this->config->isProduction() && is_file($hostingerConfig)
            ? $hostingerConfig
            : $this->config->root . '/.env';
        return Env::load($envPath);
    }

    private function internalApiEnabled(): bool
    {
        $enabled = $this->paypalEnv()->get('INTERNAL_API_ENABLED', 'false');
        return in_array(mb_strtolower((string) $enabled), ['1', 'true'], true);
    }

    private function internalApiSharedSecret(): string
    {
        return $this->paypalEnv()->get('INTERNAL_API_SHARED_SECRET', '') ?? '';
    }

    private function paymentLinkReplayCipher(): PaymentLinkReplayCipher
    {
        return PaymentLinkReplayCipher::fromHexKey($this->paypalEnv()->get('PAYMENT_LINK_ENCRYPTION_KEY', '') ?? '');
    }

    /** @return array<string,mixed>|null */
    private function adminUser(Request $request): ?array
    {
        return $this->auth()->userForToken($request->cookies['gp_admin_session'] ?? '');
    }

    private function repository(): PaymentAgreementRepository
    {
        return new PaymentAgreementRepository($this->pdo());
    }

    private function pdo(): PDO
    {
        static $pdo = null;
        return $pdo ??= Connection::open($this->config);
    }

    private function auth(): AdminAuth
    {
        if (!$this->config->hasValidAppKey()) { throw new \RuntimeException('Application security configuration is incomplete.'); }
        return new AdminAuth($this->pdo(), $this->config->appKey, $this->config->sessionTtl, $this->config->loginMaxAttempts, $this->config->loginWindowSeconds);
    }
}


