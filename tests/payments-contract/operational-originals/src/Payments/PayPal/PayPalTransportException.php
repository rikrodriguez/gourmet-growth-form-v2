<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final class PayPalTransportException extends \RuntimeException
{
    public function __construct(public readonly bool $ambiguous = true)
    {
        parent::__construct('PayPal transport failed before a definitive response was available.');
    }
}
