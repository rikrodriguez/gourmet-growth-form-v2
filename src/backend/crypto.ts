import { createCipheriv, randomBytes } from 'node:crypto';
import type { EncryptedPhone } from './contracts';

export type PhoneEncryptor = {
  encrypt(phone: string): EncryptedPhone;
};

export function createPhoneEncryptor(keyBase64: string, keyId: string): PhoneEncryptor {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('LEAD_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(keyId)) throw new Error('LEAD_ENCRYPTION_KEY_ID is invalid.');

  return {
    encrypt(phone: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        keyId,
      };
    },
  };
}
