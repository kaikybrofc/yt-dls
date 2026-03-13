class TTLCache {
  constructor({
    defaultTtlMs = 120000,
    maxEntries = 1000,
    cleanupIntervalMs = 30000,
  } = {}) {
    this.defaultTtlMs = Math.max(1000, Number(defaultTtlMs) || 120000);
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.store = new Map();

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, Math.max(1000, Number(cleanupIntervalMs) || 30000));

    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  get size() {
    this.cleanupExpired();
    return this.store.size;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    const ttl = Math.max(1000, Number(ttlMs) || this.defaultTtlMs);
    const now = Date.now();

    if (this.store.size >= this.maxEntries) {
      this.evictOne();
    }

    this.store.set(String(key), {
      value,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      expiresAt: now + ttl,
    });

    return value;
  }

  get(key) {
    const item = this.store.get(String(key));
    if (!item) return null;

    if (item.expiresAt <= Date.now()) {
      this.store.delete(String(key));
      return null;
    }

    item.lastAccessAt = Date.now();
    return item.value;
  }

  getWithMeta(key) {
    const item = this.store.get(String(key));
    if (!item) return null;

    if (item.expiresAt <= Date.now()) {
      this.store.delete(String(key));
      return null;
    }

    item.lastAccessAt = Date.now();
    return {
      value: item.value,
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ttlMs: Math.max(0, item.expiresAt - Date.now()),
    };
  }

  delete(key) {
    return this.store.delete(String(key));
  }

  has(key) {
    return this.get(key) !== null;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (item.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  evictOne() {
    let oldestKey = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, item] of this.store.entries()) {
      if (item.lastAccessAt < oldestAccess) {
        oldestAccess = item.lastAccessAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
    }
  }

  snapshot() {
    this.cleanupExpired();
    const now = Date.now();
    return Array.from(this.store.entries()).map(([key, item]) => ({
      key,
      expiresAt: item.expiresAt,
      ttlMs: Math.max(0, item.expiresAt - now),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      value: item.value,
    }));
  }
}

module.exports = { TTLCache };
