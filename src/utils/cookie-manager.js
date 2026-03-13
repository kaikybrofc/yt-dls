const fs = require("fs");
const path = require("path");

class CookieManager {
  constructor({ primaryPath, refreshIntervalMs = 60000 } = {}) {
    this.primaryPath = primaryPath;
    this.refreshIntervalMs = Math.max(5000, Number(refreshIntervalMs) || 60000);
    this.cookieFiles = [];
    this.currentIndex = 0;

    this.reload();
    this.refreshTimer = setInterval(() => {
      this.reload();
    }, this.refreshIntervalMs);

    if (typeof this.refreshTimer.unref === "function") {
      this.refreshTimer.unref();
    }
  }

  isValidCookieFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 0;
    } catch (_error) {
      return false;
    }
  }

  reload() {
    const primary = this.primaryPath;
    const dir = path.dirname(primary);
    const baseName = path.basename(primary);
    const baseNoExt = baseName.endsWith(".txt")
      ? baseName.slice(0, -4)
      : baseName;

    const candidateRegex = new RegExp(
      `^${baseNoExt.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:[._-].+)?\\.txt$`,
      "i",
    );

    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_error) {
      names = [];
    }

    const discovered = names
      .filter((name) => candidateRegex.test(name))
      .map((name) => path.join(dir, name))
      .filter((filePath) => this.isValidCookieFile(filePath))
      .sort();

    if (this.isValidCookieFile(primary) && !discovered.includes(primary)) {
      discovered.unshift(primary);
    }

    this.cookieFiles = discovered;

    if (this.currentIndex >= this.cookieFiles.length) {
      this.currentIndex = 0;
    }
  }

  getCurrent() {
    if (!this.cookieFiles.length) {
      return this.isValidCookieFile(this.primaryPath) ? this.primaryPath : null;
    }

    return this.cookieFiles[this.currentIndex] || null;
  }

  rotate(reason = "manual") {
    if (!this.cookieFiles.length) {
      return null;
    }

    this.currentIndex = (this.currentIndex + 1) % this.cookieFiles.length;
    const selected = this.getCurrent();
    console.warn(
      `🍪 Rotacao de cookies | motivo=${reason} | arquivo=${selected || "indisponivel"}`,
    );
    return selected;
  }

  getStats() {
    return {
      available: this.cookieFiles.length,
      currentIndex: this.currentIndex,
      currentPath: this.getCurrent(),
      files: this.cookieFiles,
    };
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }
}

module.exports = { CookieManager };
