// Abuse limits. A sliding-window counter per key (log-in attempts per address, registrations per
// address, failed log-ins per account name) and a token bucket (messages per connection, chat per player, datagrams
// per address). Both forget idle keys (sweep), so their memory stays bounded by the recent traffic.

// At most `limit` events per `windowMs` per key.
export class WindowLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();  // key -> [times]
  }
  recent(key) {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  // true when one more is allowed (and counts it)
  take(key) {
    if (!this.limit) return true;  // 0 = no limit
    const list = this.recent(key);
    if (list.length >= this.limit) return false;
    list.push(this.now());
    this.hits.set(key, list);
    return true;
  }
  // counts without refusing (failed log-ins); blocked() says whether the key is over
  add(key) {
    if (!this.limit) return;
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }
  blocked(key) {
    return Boolean(this.limit) && this.recent(key).length >= this.limit;
  }
  clear(key) {
    this.hits.delete(key);
  }
  sweep() {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}

// `rate` tokens per second, at most `burst` saved.
export class TokenBucket {
  constructor({ rate, burst, now = () => Date.now() }) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map();  // key -> { tokens, at }
  }
  take(key, cost = 1) {
    if (!this.rate) return true;  // 0 = no limit
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
  forget(key) {
    this.buckets.delete(key);
  }
  sweep() {
    const t = this.now();
    for (const [key, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.rate >= this.burst) this.buckets.delete(key);
  }
}
