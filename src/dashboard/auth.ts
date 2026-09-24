import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export const PASSWORD_MIN_LENGTH = 14;

export function normalizeStaffEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidStaffEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isAcceptablePassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= 256;
}

export async function hashStaffPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyStaffPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function issueSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
