type Bucket = {
  capacity: number;
  remaining: number;
  resetAt: number;
};

const WINDOW_MS = 60_000;
const buckets = new Map<string, Bucket>();

function sweep(now: number): void {
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
}

export function take(key: "global"): Bucket {
  const now = Date.now();
  sweep(now);
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { capacity: limit(), remaining: limit(), resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  if (b.remaining > 0) b.remaining--;
  return b;
}

function limit(): number {
  return Number(process.env.PERCH_PROXY_RPM?.trim() || "60");
}

export function rateLimitHeaders(b: Bucket, streaming: boolean): Record<string, string> {
  void streaming;
  const secsLeft = Math.max(0, Math.ceil((b.resetAt - Date.now()) / 1000));
  return {
    "x-ratelimit-limit-requests": String(b.capacity),
    "x-ratelimit-remaining-requests": String(Math.max(0, b.remaining)),
    "x-ratelimit-reset-requests": `${secsLeft}s`,
  };
}
