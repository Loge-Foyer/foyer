import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { inviteHash, newInviteCode } from './auth/invites';
import { databaseFile, readConfig } from './config';
import { lockHolder, lockPath } from './lock';
import { accountByName, deleteAccount, listAccounts, renewEpochs } from './store/accounts';
import { openDatabase } from './store/db';
import { deleteDevice, devicesOf } from './store/devices';
import { insertInvite } from './store/invites';

const USAGE = `sc-sync — the Streaming Center sync server's command line

  sc-sync invite [--expires 7d]           a one-time code for "Create an account" in the app
  sc-sync accounts                        every account, its devices and its log
  sc-sync devices <username>              the devices signed in to an account
  sc-sync revoke <device-id>              end a device's session; it asks for the password again
  sc-sync delete-account <username> --yes an account, its devices and its log, for good
  sc-sync backup <file>                   a copy of the database, taken while the server runs
  sc-sync restore <file>                  put a copy back — with the server stopped

It works on the database in SC_SYNC_DATA (./data by default), as the server does.`;

const DURATION = /^(\d+)([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { expires: { type: 'string', default: '7d' }, yes: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  const [command, argument] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  const { dataDir } = readConfig();
  const path = databaseFile(dataDir);

  if (command === 'restore') {
    if (!argument || !existsSync(argument)) return fail(`There is no backup at ${argument ?? '(none given)'}.`);
    const holder = lockHolder(dataDir);
    if (holder?.kind === 'running') return fail(`The server is running (process ${holder.pid}). Stop it, then restore.`);
    if (holder?.kind === 'elsewhere') {
      return fail(
        `The server on ${holder.host} holds this data. Stop it, then restore. If it is stopped already — it crashed — remove ${lockPath(dataDir)}.`,
      );
    }
    mkdirSync(dataDir, { recursive: true });
    // Through SQLite, never a file copy: a copy beside a stale write-ahead log would replay old pages over it.
    const source = new DatabaseSync(argument, { readOnly: true });
    await backup(source, path);
    source.close();
    const db = openDatabase(path);
    // The restored log is not the one any device knew: every cursor from before answers `reset`, and each device joins again with what it holds.
    const accounts = renewEpochs(db, () => randomBytes(12).toString('base64url'));
    db.close();
    console.log(`Restored ${accounts} account${accounts === 1 ? '' : 's'}. Their devices will join again with what they hold.`);
    return 0;
  }

  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path);
  try {
    switch (command) {
      case 'invite': {
        const match = DURATION.exec(values.expires);
        if (!match) return fail('--expires takes a number and m, h or d: 30m, 12h, 7d.');
        const code = newInviteCode(randomBytes);
        const hash = inviteHash(code);
        if (!hash) throw new Error('A new invite code did not read back.');
        const now = Date.now();
        insertInvite(db, hash, now, now + Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
        console.log(code);
        console.error(`Valid for ${values.expires}, for one account. In the app: Sign in → Your own server → Create an account.`);
        return 0;
      }
      case 'accounts': {
        const accounts = listAccounts(db);
        if (accounts.length === 0) console.log('No accounts yet. Make one with: sc-sync invite');
        for (const account of accounts) {
          console.log(`${account.username}  ${account.devices} device${account.devices === 1 ? '' : 's'}  ${account.changes} changes  since ${new Date(account.createdAt).toISOString()}`);
        }
        return 0;
      }
      case 'devices': {
        const account = argument ? accountByName(db, argument.normalize('NFC').toLowerCase()) : undefined;
        if (!account) return fail(`There is no account ${argument ?? '(none given)'}.`);
        for (const device of devicesOf(db, account.id)) {
          console.log(`${device.id}  ${device.name}  last seen ${new Date(device.lastSeenAt).toISOString()}`);
        }
        return 0;
      }
      case 'revoke': {
        if (!argument || !deleteDevice(db, argument)) return fail(`There is no device ${argument ?? '(none given)'}.`);
        console.log('Revoked. That device asks for the account password before it syncs again.');
        return 0;
      }
      case 'delete-account': {
        if (!argument) return fail('Name the account to delete.');
        if (!values.yes) return fail(`This deletes ${argument}, its devices and its whole log. Run it again with --yes.`);
        if (!deleteAccount(db, argument.normalize('NFC').toLowerCase())) return fail(`There is no account ${argument}.`);
        console.log(`Deleted ${argument}. Its devices keep everything they hold, and can join a new account.`);
        return 0;
      }
      case 'backup': {
        if (!argument) return fail('Name the file to back up to.');
        await backup(db, argument);
        console.log(`Backed up to ${argument}. Put it back only with: sc-sync restore ${argument}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    db.close();
  }
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
