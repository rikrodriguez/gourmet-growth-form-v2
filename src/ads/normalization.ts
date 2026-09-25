import { createHash } from 'node:crypto';

export function normalizeUsPhoneE164(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) throw new Error('invalid_phone');
  return `+1${digits}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashPhoneForGoogle(value: string): string {
  return sha256Hex(normalizeUsPhoneE164(value));
}
