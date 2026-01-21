class Semaphore {
  constructor(limit, maxQueue = 0) {
    this.limit = Math.max(1, Number.isFinite(limit) ? limit : 1);
    this.maxQueue = Math.max(0, Number.isFinite(maxQueue) ? maxQueue : 0);
    this.active = 0;
    this.activeIds = new Set();
    this.queue = [];
  }

  getStats() {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
      maxQueue: this.maxQueue,
    };
  }

  run(task, meta = {}) {
    return new Promise((resolve, reject) => {
      const ahead = this.active + this.queue.length;
      const execute = async () => {
        this.active += 1;
        if (meta.requestId) {
          this.activeIds.add(meta.requestId);
        }
        console.log(
          `🧵 Fila: iniciando job ${meta.requestId || "desconhecido"} | ativos=${this.active} | fila=${this.queue.length}`,
        );
        try {
          resolve(await task({ queueAhead: ahead, queueStats: this.getStats() }));
        } catch (error) {
          reject(error);
        } finally {
          this.active -= 1;
          if (meta.requestId) {
            this.activeIds.delete(meta.requestId);
          }
          console.log(
            `✅ Fila: finalizou job ${meta.requestId || "desconhecido"} | ativos=${this.active} | fila=${this.queue.length}`,
          );
          const next = this.queue.shift();
          if (next) next.execute();
        }
      };

      if (this.maxQueue > 0 && this.queue.length >= this.maxQueue) {
        const erro = new Error("Fila cheia");
        erro.code = "QUEUE_FULL";
        erro.stats = this.getStats();
        return reject(erro);
      }

      if (this.active < this.limit) {
        execute();
      } else {
        this.queue.push({ execute, requestId: meta.requestId || null });
        console.log(
          `📥 Fila: enfileirado job ${meta.requestId || "desconhecido"} | ativos=${this.active} | fila=${this.queue.length}`,
        );
      }
    });
  }

  getQueueInfo(requestId) {
    if (!requestId) return null;
    if (this.activeIds.has(requestId)) {
      return {
        status: "active",
        downloads_a_frente: 0,
        enfileirados: this.queue.length,
      };
    }
    const index = this.queue.findIndex((item) => item.requestId === requestId);
    if (index === -1) return null;
    return {
      status: "queued",
      downloads_a_frente: this.active + index,
      posicao_na_fila: index + 1,
      enfileirados: this.queue.length,
    };
  }
}

module.exports = { Semaphore };
