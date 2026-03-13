function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

class MetricsCollector {
  constructor({ maxSamplesPerMetric = 500 } = {}) {
    this.startedAt = Date.now();
    this.maxSamplesPerMetric = Math.max(50, Number(maxSamplesPerMetric) || 500);
    this.counters = new Map();
    this.timings = new Map();
  }

  increment(name, delta = 1) {
    const metricName = String(name);
    const value = Number(delta) || 0;
    const current = this.counters.get(metricName) || 0;
    this.counters.set(metricName, current + value);
  }

  observe(name, valueMs) {
    const metricName = String(name);
    const ms = Number(valueMs);
    if (!Number.isFinite(ms) || ms < 0) return;

    const data = this.timings.get(metricName) || {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      samples: [],
    };

    data.count += 1;
    data.sum += ms;
    data.min = Math.min(data.min, ms);
    data.max = Math.max(data.max, ms);
    data.samples.push(ms);

    if (data.samples.length > this.maxSamplesPerMetric) {
      data.samples.shift();
    }

    this.timings.set(metricName, data);
  }

  snapshot() {
    const counters = {};
    for (const [name, value] of this.counters.entries()) {
      counters[name] = value;
    }

    const timings = {};
    for (const [name, data] of this.timings.entries()) {
      timings[name] = {
        count: data.count,
        avg: data.count > 0 ? data.sum / data.count : 0,
        min: data.count > 0 ? data.min : 0,
        max: data.max,
        p95: percentile(data.samples, 95),
      };
    }

    const total = counters.requests_total || 0;
    const errors = counters.requests_error || 0;

    return {
      uptime_ms: Date.now() - this.startedAt,
      counters,
      timings,
      derived: {
        cache_hit: counters.resolve_cache_hit || 0,
        error_rate: total > 0 ? errors / total : 0,
      },
    };
  }
}

module.exports = { MetricsCollector };
