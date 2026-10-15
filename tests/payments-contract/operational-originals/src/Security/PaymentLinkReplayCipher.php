<?php

declare(strict_types=1);

namespace Gourmet\Payments\Security;

/**
 * Encrypts the one-time internal API replay response. Public payment links
 * remain hash-only for validation; this cipher is solely for authenticated,
 * same-key recovery by the originating service.
 */
final readonly class PaymentLinkReplayCipher
{
    private const CIPHER = 'aes-256-gcm';
    private const AAD = 'gourmet-payments:internal-payment-agreement-replay:v1';

    private function __construct(private string $key)
    {
    }

    public static function fromHexKey(string $value): self
    {
        if (preg_match('/\A[a-f0-9]{64}\z/i', $value) !== 1) {
            throw new \RuntimeException('Payment-link replay encryption is not configured.');
        }
        $key = hex2bin($value);
        if ($key === false) {
            throw new \RuntimeException('Payment-link replay encryption is not configured.');
        }
        return new self($key);
    }

    /** @return array{ciphertext:string,nonce:string,tag:string} */
    public function encrypt(string $plaintext): array
    {
        $nonce = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt($plaintext, self::CIPHER, $this->key, OPENSSL_RAW_DATA, $nonce, $tag, self::AAD, 16);
        if (!is_string($ciphertext) || strlen($tag) !== 16) {
            throw new \RuntimeException('Unable to protect payment-link replay data.');
        }
        return ['ciphertext' => $ciphertext, 'nonce' => $nonce, 'tag' => $tag];
    }

    public function decrypt(string $ciphertext, string $nonce, string $tag): string
    {
        if (strlen($nonce) !== 12 || strlen($tag) !== 16) {
            throw new \RuntimeException('Stored payment-link replay data is invalid.');
        }
        $plaintext = openssl_decrypt($ciphertext, self::CIPHER, $this->key, OPENSSL_RAW_DATA, $nonce, $tag, self::AAD);
        if (!is_string($plaintext)) {
            throw new \RuntimeException('Stored payment-link replay data cannot be recovered.');
        }
        return $plaintext;
    }
}
