import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function createLoginRateLimit(options?: {
  windowMs?: number;
  maxAttempts?: number;
  maxBuckets?: number;
  bucketPrefix?: string;
  errorMessage?: string;
}): RequestHandler {
  const windowMs = options?.windowMs ?? 15 * 60_000;
  const maxAttempts = options?.maxAttempts ?? 10;
  const maxBuckets = Math.max(100, options?.maxBuckets ?? 10_000);
  const bucketPrefix = options?.bucketPrefix ?? "login";

  return (req, res, next) => {
    const now = Date.now();
    // Bound memory for high-cardinality/spoofed IP traffic. Redis is not present
    // in this repository; this remains a per-process MVP limiter.
    if (buckets.size >= maxBuckets) {
      for (const [bucketKey, bucketValue] of buckets) {
        if (bucketValue.resetAt <= now) buckets.delete(bucketKey);
      }
      while (buckets.size >= maxBuckets) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (!oldestKey) break;
        buckets.delete(oldestKey);
      }
    }
    const key = `${bucketPrefix}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const existing = buckets.get(key);
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;
    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader("RateLimit-Limit", String(maxAttempts));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, maxAttempts - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxAttempts) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: options?.errorMessage ?? "Bạn thử đăng nhập quá nhiều lần. Vui lòng chờ rồi thử lại." });
      return;
    }
    next();
  };
}

export function clearLoginRateLimitForTests(): void {
  buckets.clear();
}
