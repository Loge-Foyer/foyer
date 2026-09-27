/**
 * Misses, counted per bucket, in memory. A few are free; then each costs a
 * wait, doubling up to a ceiling; a success clears the bucket. Never kept on
 * disk and never permanent: a lock that outlived a restart would hand anyone
 * who knows a username a way to keep its owner out.
 */
export interface Throttle {
  /** How long before any of these buckets may try again; 0 when all may. */
  waitFor(buckets: readonly string[]): number;
  miss(buckets: readonly string[]): void;
  clear(buckets: readonly string[]): void;
}

export interface ThrottlePolicy {
  readonly free: number;
  readonly firstWaitMs: number;
  readonly maxWaitMs: number;
}

export const SUBJECT_POLICY: ThrottlePolicy = { free: 5, firstWaitMs: 30_000, maxWaitMs: 15 * 60_000 };
/** An address may miss more, across every name it tries, before it waits too. */
export const ADDRESS_POLICY: ThrottlePolicy = { free: 20, firstWaitMs: 30_000, maxWaitMs: 15 * 60_000 };

const FORGET_AFTER_MS = 60 * 60_000;

export function createThrottle(now: () => number, policyOf: (bucket: string) => ThrottlePolicy): Throttle {
  const buckets = new Map<string, { misses: number; until: number; last: number }>();

  const sweep = () => {
    const time = now();
    for (const [key, bucket] of buckets) if (time - bucket.last > FORGET_AFTER_MS && bucket.until <= time) buckets.delete(key);
  };

  return {
    waitFor: (keys) => Math.max(0, ...keys.map((key) => (buckets.get(key)?.until ?? 0) - now())),
    miss: (keys) => {
      if (buckets.size > 10_000) sweep();
      const time = now();
      for (const key of keys) {
        const policy = policyOf(key);
        const bucket = buckets.get(key) ?? { misses: 0, until: 0, last: time };
        bucket.misses += 1;
        bucket.last = time;
        if (bucket.misses >= policy.free) {
          bucket.until = time + Math.min(policy.firstWaitMs * 2 ** (bucket.misses - policy.free), policy.maxWaitMs);
        }
        buckets.set(key, bucket);
      }
    },
    clear: (keys) => {
      for (const key of keys) buckets.delete(key);
    },
  };
}
