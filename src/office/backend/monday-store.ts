import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

// Revisions are opaque CAS tokens; they grow across key deletion/recreation.
export type MondayStoredRecord = { revision: number; value: unknown };
export interface MondayStore {
  read(key: string): Promise<MondayStoredRecord | null>;
  compareAndSet(key: string, expectedRevision: number | null, record: unknown | null): Promise<boolean>;
}
export type MondaySealedRecord = { version: 1; iv: string; ciphertext: string; tag: string };
export type MondayStoreErrorCode = 'MONDAY_STORE_INVALID_KEY' | 'MONDAY_STORE_INVALID_REVISION' | 'MONDAY_STORE_INVALID_RECORD' | 'MONDAY_STORE_UNAVAILABLE';
export class MondayStoreError extends Error {
  constructor(public readonly code: MondayStoreErrorCode) { super(code); this.name = 'MondayStoreError'; }
}
export class MondayVaultError extends Error {
  readonly code = 'MONDAY_VAULT_INVALID';
  constructor() { super('MONDAY_VAULT_INVALID'); this.name = 'MondayVaultError'; }
}

const MAX_RECORD_BYTES = 1_048_576;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
function checkedKey(key: string): string {
  if (typeof key !== 'string' || !/^monday-[A-Za-z0-9][A-Za-z0-9._:-]{0,112}$/.test(key) || /[^A-Za-z0-9._:-]/.test(key)) throw new MondayStoreError('MONDAY_STORE_INVALID_KEY');
  return key;
}
function checkedRevision(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > MAX_REVISION)) throw new MondayStoreError('MONDAY_STORE_INVALID_REVISION');
}

// Inspect descriptors before serializing. Stored records are JSON data, never
// getters, toJSON callbacks, class instances or lossy non-finite values.
function json(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth = 0): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return;
    if (!current || typeof current !== 'object' || depth > 64 || ancestors.has(current)) throw new MondayStoreError('MONDAY_STORE_INVALID_RECORD');
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new MondayStoreError('MONDAY_STORE_INVALID_RECORD');
    const keys = Reflect.ownKeys(current);
    if (keys.length > 100_000 || array && keys.length !== current.length + 1) throw new MondayStoreError('MONDAY_STORE_INVALID_RECORD');
    ancestors.add(current);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || (!array || key !== 'length') && !descriptor.enumerable || array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) throw new MondayStoreError('MONDAY_STORE_INVALID_RECORD');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  };
  visit(value);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw new MondayStoreError('MONDAY_STORE_INVALID_RECORD');
  return serialized;
}
function recordInput(expectedRevision: number | null, record: unknown | null): string | null {
  checkedRevision(expectedRevision);
  if (record === null) return null;
  if (expectedRevision === MAX_REVISION) throw new MondayStoreError('MONDAY_STORE_INVALID_REVISION');
  return json(record);
}

// This table has its own CAS revisions and never locks the Office aggregate.
// Sensitive values must be sealed by the caller before reaching this generic
// store. Each operation issues one SQL statement and invokes no external API.
export class PostgresMondayStore implements MondayStore {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }
  async read(key: string): Promise<MondayStoredRecord | null> {
    checkedKey(key);
    try {
      const result = await this.#pool.query<{ revision: string; value: unknown }>('SELECT revision, payload AS value FROM office_demo.monday_private_records WHERE key=$1', [key]);
      if (!result.rows.length) return null;
      const revision = Number(result.rows[0].revision);
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) throw new MondayStoreError('MONDAY_STORE_UNAVAILABLE');
      return { revision, value: result.rows[0].value };
    } catch { throw new MondayStoreError('MONDAY_STORE_UNAVAILABLE'); }
  }
  async compareAndSet(key: string, expectedRevision: number | null, record: unknown | null): Promise<boolean> {
    checkedKey(key);
    const payload = recordInput(expectedRevision, record);
    try {
      if (payload === null && expectedRevision === null) {
        const result = await this.#pool.query<{ absent: boolean }>('SELECT NOT EXISTS (SELECT 1 FROM office_demo.monday_private_records WHERE key=$1) AS absent', [key]);
        return result.rows[0].absent;
      }
      const result = payload === null
        ? await this.#pool.query('DELETE FROM office_demo.monday_private_records WHERE key=$1 AND revision=$2 RETURNING revision', [key, expectedRevision])
        : expectedRevision === null
          ? await this.#pool.query('INSERT INTO office_demo.monday_private_records(key, revision, payload) VALUES($1,nextval(\'office_demo.monday_private_revision_seq\'),$2::jsonb) ON CONFLICT(key) DO NOTHING RETURNING revision', [key, payload])
          : await this.#pool.query('UPDATE office_demo.monday_private_records SET revision=nextval(\'office_demo.monday_private_revision_seq\'), payload=$3::jsonb, updated_at=clock_timestamp() WHERE key=$1 AND revision=$2 RETURNING revision', [key, expectedRevision, payload]);
      return result.rowCount === 1;
    } catch { throw new MondayStoreError('MONDAY_STORE_UNAVAILABLE'); }
  }
}

export class MemoryMondayStore implements MondayStore {
  private readonly rows = new Map<string, { revision: number; payload: string }>();
  private nextRevision = 1;
  async read(key: string): Promise<MondayStoredRecord | null> {
    const row = this.rows.get(checkedKey(key));
    return row ? { revision: row.revision, value: JSON.parse(row.payload) as unknown } : null;
  }
  async compareAndSet(key: string, expectedRevision: number | null, record: unknown | null): Promise<boolean> {
    checkedKey(key);
    const payload = recordInput(expectedRevision, record);
    const current = this.rows.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    if (payload === null) this.rows.delete(key);
    else {
      if (this.nextRevision > MAX_REVISION) throw new MondayStoreError('MONDAY_STORE_UNAVAILABLE');
      this.rows.set(key, { revision: this.nextRevision++, payload });
    }
    return true;
  }
}

function bindingBytes(binding: string): Buffer {
  if (typeof binding !== 'string' || !binding.length || binding.length > 512 || /[\u0000-\u001f\u007f]/u.test(binding)) throw new MondayVaultError();
  return Buffer.from(binding, 'utf8');
}
function base64Bytes(value: unknown, size?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_RECORD_BYTES * 2) throw new MondayVaultError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || size !== undefined && bytes.length !== size || size === undefined && (!bytes.length || bytes.length > MAX_RECORD_BYTES)) throw new MondayVaultError();
  return bytes;
}
export class MondayVault {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new MondayVaultError();
    this.#key = Buffer.from(key);
  }
  seal(value: unknown, binding: string): MondaySealedRecord {
    try {
      const aad = bindingBytes(binding);
      const plaintext = Buffer.from(json(value), 'utf8');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version: 1, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    } catch { throw new MondayVaultError(); }
  }
  open(sealed: unknown, binding: string): unknown {
    try {
      const aad = bindingBytes(binding);
      if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed) || ![Object.prototype, null].includes(Object.getPrototypeOf(sealed))) throw new MondayVaultError();
      const values: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(sealed)) {
        const descriptor = Object.getOwnPropertyDescriptor(sealed, key);
        if (typeof key !== 'string' || !['version', 'iv', 'ciphertext', 'tag'].includes(key) || !descriptor?.enumerable || !('value' in descriptor)) throw new MondayVaultError();
        values[key] = descriptor.value;
      }
      if (Object.keys(values).length !== 4 || values.version !== 1) throw new MondayVaultError();
      const iv = base64Bytes(values.iv, 12);
      const ciphertext = base64Bytes(values.ciphertext);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(base64Bytes(values.tag, 16));
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch { throw new MondayVaultError(); }
  }
}
