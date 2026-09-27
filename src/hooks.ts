import type { Faults } from './store/changes';

/**
 * Crash points for the crash test: `SC_SYNC_CRASH=insert:<n>` exits before a
 * push's n-th insert, `commit:<n>` after the n-th push commits but before its
 * answer leaves. Read only with `SC_SYNC_TEST_HOOKS=1`, so no ordinary
 * configuration can reach them.
 */
export function crashHooks(env: Readonly<Record<string, string | undefined>>): Faults | undefined {
  if (env.SC_SYNC_TEST_HOOKS !== '1') return undefined;
  const match = /^(insert|commit):(\d+)$/.exec(env.SC_SYNC_CRASH ?? '');
  if (!match) return undefined;
  const at = Number(match[2]);
  let seen = 0;
  const crash = () => {
    seen += 1;
    if (seen === at) process.exit(137);
  };
  return match[1] === 'insert' ? { beforeInsert: crash } : { afterCommit: crash };
}
