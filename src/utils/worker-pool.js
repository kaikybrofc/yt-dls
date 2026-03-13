class WorkerPool {
  constructor({ size = 2, maxQueue = 100, name = "worker" } = {}) {
    this.name = name;
    this.size = Math.max(1, Number(size) || 1);
    this.maxQueue = Math.max(0, Number(maxQueue) || 0);

    this.active = 0;
    this.queue = [];
    this.waiters = [];
    this.running = true;

    for (let i = 0; i < this.size; i += 1) {
      this.startWorker(i);
    }
  }

  startWorker(workerId) {
    const loop = async () => {
      while (this.running) {
        const job = await this.dequeue();
        if (!job) return;

        this.active += 1;
        try {
          const result = await job.task({ workerId, pool: this.name });
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          this.active -= 1;
        }
      }
    };

    loop().catch((error) => {
      console.error(`❌ WorkerPool falhou | pool=${this.name} | ${error.message}`);
    });
  }

  dequeue() {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  run(task, meta = {}) {
    return new Promise((resolve, reject) => {
      if (this.maxQueue > 0 && this.queue.length >= this.maxQueue) {
        const error = new Error("Fila do worker pool cheia");
        error.code = "WORKER_POOL_QUEUE_FULL";
        error.pool = this.name;
        error.stats = this.getStats();
        return reject(error);
      }

      const job = {
        task,
        resolve,
        reject,
        meta,
        enqueuedAt: Date.now(),
      };

      const waitingWorker = this.waiters.shift();
      if (waitingWorker) {
        waitingWorker(job);
      } else {
        this.queue.push(job);
      }
    });
  }

  getStats() {
    return {
      pool: this.name,
      size: this.size,
      active: this.active,
      queued: this.queue.length,
      maxQueue: this.maxQueue,
    };
  }

  stop() {
    this.running = false;

    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve(null);
    }
  }
}

module.exports = { WorkerPool };
