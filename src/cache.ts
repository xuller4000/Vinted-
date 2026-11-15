/**
 * Small result cache in Workers KV. Vinted rate-limits quickly, so every answer that can come
 * from here is one request less. Entries live for a day; within `freshMs` they are served as-is,
 * after that only when Vinted refuses (HTTP 403/429), marked with their age.
 */
let kv: KVNamespace | undefined;

export function useCache(namespace: KVNamespace | undefined): void {
  kv = namespace;
}

export class BlockedError extends Error {
  constructor(status: number) {
    super(
      `Vinted drosselt gerade (HTTP ${status}). Meist ist das nach ein bis zwei Minuten vorbei; ` +
        "bis dahin bitte keine weiteren Abfragen schicken.",
    );
  }
}

const KEEP_SECONDS = 24 * 60 * 60;

interface Entry<T> {
  t: number;
  v: T;
}

export interface Cached<T> {
  value: T;
  /** Age in minutes when a stale entry stood in for a blocked request, otherwise undefined. */
  staleMinutes?: number;
}

/** KV keys may be at most 512 bytes; long search URLs are hashed. */
async function kvKey(key: string): Promise<string> {
  if (new TextEncoder().encode(key).length <= 400) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `h:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function cached<T>(rawKey: string, freshMs: number, produce: () => Promise<T>): Promise<Cached<T>> {
  const key = await kvKey(rawKey);
  let hit: Entry<T> | null = null;
  try {
    hit = (await kv?.get<Entry<T>>(key, "json")) ?? null;
  } catch {
    // A broken cache must never break a lookup.
  }
  if (hit && Date.now() - hit.t < freshMs) return { value: hit.v };
  try {
    const value = await produce();
    try {
      await kv?.put(key, JSON.stringify({ t: Date.now(), v: value }), { expirationTtl: KEEP_SECONDS });
    } catch {
      // KV write limits (1000/day on the free plan) only cost the cache, not the answer.
    }
    return { value };
  } catch (e) {
    if (e instanceof BlockedError && hit) {
      return { value: hit.v, staleMinutes: Math.round((Date.now() - hit.t) / 60_000) };
    }
    throw e;
  }
}
