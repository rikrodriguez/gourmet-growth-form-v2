import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  PASSWORD_MIN_LENGTH,
  hashStaffPassword,
  isAcceptablePassword,
  isValidStaffEmail,
  normalizeStaffEmail,
} from './auth';

const { Client } = pg;

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('A TTY is required. Alternatively set STAFF_PASSWORD_FILE to a protected local file.');
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\u007f') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

const databaseUrl = process.env.STAFF_ADMIN_DATABASE_URL;
if (!databaseUrl) throw new Error('STAFF_ADMIN_DATABASE_URL is required.');
const email = normalizeStaffEmail(argument('email') ?? process.env.STAFF_EMAIL ?? '');
const role = argument('role') ?? 'admin';
if (!isValidStaffEmail(email)) throw new Error('A valid --email is required.');
if (role !== 'admin' && role !== 'viewer') throw new Error('Role must be admin or viewer.');

const passwordFile = process.env.STAFF_PASSWORD_FILE;
const password = passwordFile
  ? (await readFile(passwordFile, 'utf8')).replace(/[\r\n]+$/, '')
  : await promptHidden(`Password (${PASSWORD_MIN_LENGTH}+ characters, input hidden): `);
if (!isAcceptablePassword(password)) throw new Error(`Password must be ${PASSWORD_MIN_LENGTH}–256 characters.`);

const passwordHash = await hashStaffPassword(password);
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `INSERT INTO growth_v2.staff_users
      (staff_user_id,email,password_hash,role,enabled)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (email) DO UPDATE SET
       password_hash=EXCLUDED.password_hash,
       role=EXCLUDED.role,
       enabled=true,
       updated_at=now()`,
    [randomUUID(), email, passwordHash, role],
  );
  process.stdout.write(`Provisioned ${role} staff user for ${email}.\n`);
} finally {
  await client.end();
}

