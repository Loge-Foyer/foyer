import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAccount, freePort, inviteInto, pullIds, push, startServer } from './support/process';
import { profile } from './support/server';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-sync-crash-'));
  dirs.push(dir);
  return dir;
}

const batch = (from: number, count: number) => Array.from({ length: count }, (_, index) => profile(`c${from + index}`, `P${from + index}`));

// The server killed where a push is most fragile, then started again: the log
// must hold every change a device was told was stored, once, in order — and
// the device, sending again what it was not told, must not duplicate any.
describe('a server that dies during a push', () => {
  it('loses the whole push when it dies before committing, and stores the resend once', async () => {
    const dir = dataDir();
    const port = await freePort();
    const invite = inviteInto(dir);
    const dying = await startServer(dir, port, { SC_SYNC_TEST_HOOKS: '1', SC_SYNC_CRASH: 'insert:3' });
    const token = await createAccount(dying.base, invite);
    await expect(push(dying.base, token, batch(1, 5))).rejects.toThrow();
    expect(await dying.exited).toBe(137);

    const again = await startServer(dir, port);
    expect(await pullIds(again.base, token)).toEqual([]);
    expect((await push(again.base, token, batch(1, 5))).accepted).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(await pullIds(again.base, token)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    await again.stop();
  });

  it('keeps a push it committed but never answered, and stores the resend once', async () => {
    const dir = dataDir();
    const port = await freePort();
    const invite = inviteInto(dir);
    const dying = await startServer(dir, port, { SC_SYNC_TEST_HOOKS: '1', SC_SYNC_CRASH: 'commit:1' });
    const token = await createAccount(dying.base, invite);
    await expect(push(dying.base, token, batch(1, 3))).rejects.toThrow();
    expect(await dying.exited).toBe(137);

    const again = await startServer(dir, port);
    expect(await pullIds(again.base, token)).toEqual(['c1', 'c2', 'c3']);
    // What the device never heard back about goes again, with what it has made since.
    expect((await push(again.base, token, batch(1, 4))).accepted).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(await pullIds(again.base, token)).toEqual(['c1', 'c2', 'c3', 'c4']);
    await again.stop();
  });

  it('ignores the crash points unless the test hooks are switched on', async () => {
    const dir = dataDir();
    const port = await freePort();
    const invite = inviteInto(dir);
    const server = await startServer(dir, port, { SC_SYNC_CRASH: 'insert:1' });
    const token = await createAccount(server.base, invite);
    expect((await push(server.base, token, batch(1, 2))).accepted).toEqual(['c1', 'c2']);
    await server.stop();
  });
});
