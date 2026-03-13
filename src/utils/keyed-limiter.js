class KeyedLimiter {
  constructor({ limitPerKey = 3, keyLabel = "key" } = {}) {
    this.limitPerKey = Math.max(1, Number(limitPerKey) || 1);
    this.keyLabel = keyLabel;
    this.activeByKey = new Map();
  }

  tryAcquire(key) {
    const normalized = String(key || "unknown");
    const active = this.activeByKey.get(normalized) || 0;
    if (active >= this.limitPerKey) {
      return {
        acquired: false,
        key: normalized,
        active,
        limit: this.limitPerKey,
      };
    }

    this.activeByKey.set(normalized, active + 1);
    return {
      acquired: true,
      key: normalized,
      active: active + 1,
      limit: this.limitPerKey,
    };
  }

  release(key) {
    const normalized = String(key || "unknown");
    const active = this.activeByKey.get(normalized) || 0;

    if (active <= 1) {
      this.activeByKey.delete(normalized);
      return;
    }

    this.activeByKey.set(normalized, active - 1);
  }

  getStats(key) {
    const normalized = String(key || "unknown");
    return {
      key: normalized,
      active: this.activeByKey.get(normalized) || 0,
      limit: this.limitPerKey,
      keyLabel: this.keyLabel,
    };
  }
}

module.exports = { KeyedLimiter };
