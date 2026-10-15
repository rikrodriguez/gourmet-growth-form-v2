<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final class CurlPayPalHttpTransport implements PayPalHttpTransport
{
    public function send(
        string $method,
        string $url,
        array $headers,
        ?string $body,
        int $timeoutSeconds,
    ): PayPalHttpResponse {
        if (!extension_loaded('curl')) {
            throw new PayPalTransportException();
        }

        $handle = curl_init($url);
        if ($handle === false) {
            throw new PayPalTransportException();
        }

        $formattedHeaders = [];
        foreach ($headers as $name => $value) {
            $formattedHeaders[] = $name . ': ' . $value;
        }

        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $formattedHeaders,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(10, $timeoutSeconds),
            CURLOPT_TIMEOUT => $timeoutSeconds,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }

        $responseBody = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $errorNumber = curl_errno($handle);
        curl_close($handle);

        if ($responseBody === false || $errorNumber !== 0 || $status === 0) {
            throw new PayPalTransportException();
        }

        return new PayPalHttpResponse($status, (string) $responseBody);
    }
}
