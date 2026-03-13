const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  HOST,
  PORT,
  YTDLP_BINARY_PATH,
  COOKIES_PATH,
  DOWNLOADS_DIR,
  VIDEO_FORMAT,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_LABEL,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_QUEUE_SIZE,
  MAX_CONCURRENT_FFMPEG,
  CONVERT_TIMEOUT_MS,
  RESOLVE_CACHE_TTL_MS,
  TRACK_CACHE_MAX,
  SIGNED_URL_TTL_MS,
  SIGNED_URL_SECRET,
  WARM_CHUNK_BYTES,
  WARM_CHUNK_TTL_MS,
  RESOLVE_POOL_SIZE,
  PREFETCH_POOL_SIZE,
  POOL_QUEUE_SIZE,
  MAX_ACTIVE_STREAMS_PER_IP,
  MAX_ACTIVE_STREAMS_PER_GUILD,
  MAX_ACTIVE_RESOLVES_PER_IP,
  MAX_ACTIVE_RESOLVES_PER_GUILD,
  YTDLP_MAX_RETRIES,
  YTDLP_RETRY_BASE_DELAY_MS,
  COOKIE_REFRESH_INTERVAL_MS,
  UPSTREAM_REQUEST_TIMEOUT_MS,
  PREFETCH_QUEUE_MAX,
  PUBLIC_BASE_URL,
  ENABLE_OPUS_TRANSCODE,
  OPUS_BITRATE,
} = require("./config");
const { Semaphore } = require("./utils/semaphore");
const { isYoutubeLink, isValidRequestId } = require("./utils/validators");
const { createMediaConverter, hasAudioStream } = require("./utils/media");
const { streamFileResponse } = require("./utils/stream");
const { TTLCache } = require("./utils/ttl-cache");
const { WorkerPool } = require("./utils/worker-pool");
const { KeyedLimiter } = require("./utils/keyed-limiter");
const { MetricsCollector } = require("./utils/metrics");
const { CookieManager } = require("./utils/cookie-manager");
const {
  parseExpireFromStreamUrl,
  fetchWarmupChunk,
  proxyRemoteStream,
} = require("./utils/remote-stream");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  metrics.increment("requests_total", 1);
  res.on("finish", () => {
    if (res.statusCode >= 400) {
      metrics.increment("requests_error", 1);
    }
  });
  next();
});

// Garante pasta de downloads
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Inicializa yt-dlp
const ytDlpWrap = new YTDlpWrap(YTDLP_BINARY_PATH);

// ==================== UTIL ====================
const downloadSemaphore = new Semaphore(
  MAX_CONCURRENT_DOWNLOADS,
  MAX_QUEUE_SIZE,
);
const ffmpegSemaphore = new Semaphore(MAX_CONCURRENT_FFMPEG, 0);
const { convertMedia } = createMediaConverter({
  ffmpegSemaphore,
  convertTimeoutMs: CONVERT_TIMEOUT_MS,
});
const metrics = new MetricsCollector();

const resolveCacheByLookup = new TTLCache({
  defaultTtlMs: RESOLVE_CACHE_TTL_MS,
  maxEntries: TRACK_CACHE_MAX,
});
const resolveCacheByTrackId = new TTLCache({
  defaultTtlMs: RESOLVE_CACHE_TTL_MS,
  maxEntries: TRACK_CACHE_MAX,
});
const prefetchStatusCache = new TTLCache({
  defaultTtlMs: Math.max(RESOLVE_CACHE_TTL_MS, 120000),
  maxEntries: TRACK_CACHE_MAX,
});

const resolveWorkerPool = new WorkerPool({
  name: "resolve-pool",
  size: RESOLVE_POOL_SIZE,
  maxQueue: POOL_QUEUE_SIZE,
});
const prefetchWorkerPool = new WorkerPool({
  name: "prefetch-pool",
  size: PREFETCH_POOL_SIZE,
  maxQueue: PREFETCH_QUEUE_MAX,
});

const streamIpLimiter = new KeyedLimiter({
  limitPerKey: MAX_ACTIVE_STREAMS_PER_IP,
  keyLabel: "ip",
});
const streamGuildLimiter = new KeyedLimiter({
  limitPerKey: MAX_ACTIVE_STREAMS_PER_GUILD,
  keyLabel: "guild",
});
const resolveIpLimiter = new KeyedLimiter({
  limitPerKey: MAX_ACTIVE_RESOLVES_PER_IP,
  keyLabel: "ip",
});
const resolveGuildLimiter = new KeyedLimiter({
  limitPerKey: MAX_ACTIVE_RESOLVES_PER_GUILD,
  keyLabel: "guild",
});
const prefetchIpLimiter = new KeyedLimiter({
  limitPerKey: Math.max(1, Math.floor(MAX_ACTIVE_RESOLVES_PER_IP / 2)),
  keyLabel: "ip",
});
const prefetchGuildLimiter = new KeyedLimiter({
  limitPerKey: Math.max(1, Math.floor(MAX_ACTIVE_RESOLVES_PER_GUILD / 2)),
  keyLabel: "guild",
});
const cookieManager = new CookieManager({
  primaryPath: COOKIES_PATH,
  refreshIntervalMs: COOKIE_REFRESH_INTERVAL_MS,
});

const YOUTUBE_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "LOGIN_INFO",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-3PAPISID",
]);

function isYoutubeBotCheckError(text) {
  if (!text) return false;
  return /sign in to confirm you(?:'|’)re not a bot/i.test(String(text));
}

function extractYtDlpErrorText(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return (
    err.stderr ||
    err.stdout ||
    err.message ||
    (typeof err.toString === "function" ? err.toString() : String(err))
  );
}

function isRequestedFormatUnavailableError(text) {
  if (!text) return false;
  return /requested format is not available/i.test(String(text));
}

function analyzeCookiesFile(filePath) {
  const report = {
    totalCookies: 0,
    hasYoutubeDomain: false,
    hasAuthCookie: false,
    authCookieNames: [],
  };

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (erro) {
    return { ...report, readError: erro.message };
  }

  const authFound = new Set();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "# Netscape HTTP Cookie File") continue;

    const columns = line.split("\t");
    if (columns.length < 7) continue;

    let domain = columns[0].trim();
    if (!domain) continue;

    if (domain.startsWith("#HttpOnly_")) {
      domain = domain.slice("#HttpOnly_".length);
    } else if (domain.startsWith("#")) {
      continue;
    }

    const cookieName = columns[5]?.trim();
    if (!cookieName) continue;

    report.totalCookies += 1;
    if (/youtube\.com$/i.test(domain.replace(/^\./, ""))) {
      report.hasYoutubeDomain = true;
    }
    if (YOUTUBE_AUTH_COOKIE_NAMES.has(cookieName)) {
      report.hasAuthCookie = true;
      authFound.add(cookieName);
    }
  }

  report.authCookieNames = Array.from(authFound).sort();
  return report;
}

function buildCommonYtDlpArgs({ includeCookies = true, cookiePath = null } = {}) {
  const args = [];
  if (includeCookies) {
    const selectedCookiePath = cookiePath || cookieManager.getCurrent() || COOKIES_PATH;
    if (selectedCookiePath) {
      args.push("--cookies", selectedCookiePath);
    }
  }

  args.push(
    "--js-runtimes",
    "node",
    "--extractor-args",
    "youtube:player_client=android,web",
    "--no-warnings",
  );

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResolveType(type) {
  return String(type || "audio").toLowerCase() === "video" ? "video" : "audio";
}

function createResolveLookupKey(link, type) {
  return `${normalizeResolveType(type)}::${String(link || "").trim()}`;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getGuildIdFromRequest(req) {
  const fromHeader = String(req.headers["x-guild-id"] || "").trim();
  if (fromHeader) return fromHeader;

  const fromQuery = String(req.query?.guild_id || "").trim();
  if (fromQuery) return fromQuery;

  return String(req.body?.guild_id || "").trim();
}

function pickThumbnail(info) {
  if (!info) return null;
  if (info.thumbnail) return info.thumbnail;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
    const candidate = info.thumbnails[info.thumbnails.length - 1];
    if (candidate && candidate.url) return candidate.url;
  }
  return null;
}

function guessMimeTypeFromFormat(format, tipo) {
  const ext = String(format?.ext || "").toLowerCase();
  if (tipo === "audio") {
    if (ext === "webm") return "audio/webm";
    if (ext === "m4a") return "audio/mp4";
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "opus") return "audio/ogg";
    return "audio/webm";
  }

  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

function selectPreferredFormat(info, tipo) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  if (!formats.length) return null;

  if (tipo === "audio") {
    const audioFormats = formats
      .filter((format) => {
        if (!format || !format.url) return false;
        const acodec = String(format.acodec || "none").toLowerCase();
        return acodec !== "none";
      })
      .sort((a, b) => {
        const scoreA =
          (String(a.vcodec || "none") === "none" ? 1000 : 0) +
          (Number(a.abr) || 0) +
          (Number(a.tbr) || 0);
        const scoreB =
          (String(b.vcodec || "none") === "none" ? 1000 : 0) +
          (Number(b.abr) || 0) +
          (Number(b.tbr) || 0);
        return scoreB - scoreA;
      });

    return audioFormats[0] || null;
  }

  const avFormats = formats
    .filter((format) => {
      if (!format || !format.url) return false;
      const vcodec = String(format.vcodec || "none").toLowerCase();
      const acodec = String(format.acodec || "none").toLowerCase();
      return vcodec !== "none" && acodec !== "none";
    })
    .sort((a, b) => {
      const scoreA = (Number(a.height) || 0) * 10 + (Number(a.tbr) || 0);
      const scoreB = (Number(b.height) || 0) * 10 + (Number(b.tbr) || 0);
      return scoreB - scoreA;
    });

  if (avFormats[0]) return avFormats[0];

  const videoOnly = formats
    .filter((format) => {
      if (!format || !format.url) return false;
      const vcodec = String(format.vcodec || "none").toLowerCase();
      return vcodec !== "none";
    })
    .sort((a, b) => {
      const scoreA = (Number(a.height) || 0) * 10 + (Number(a.tbr) || 0);
      const scoreB = (Number(b.height) || 0) * 10 + (Number(b.tbr) || 0);
      return scoreB - scoreA;
    });

  return videoOnly[0] || null;
}

function isRetryableAntiBotError(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase();
  return (
    normalized.includes("sign in to confirm you're not a bot") ||
    normalized.includes("http error 429") ||
    normalized.includes("too many requests") ||
    normalized.includes("captcha")
  );
}

function createSignature(trackId, expiresAt) {
  return crypto
    .createHmac("sha256", SIGNED_URL_SECRET)
    .update(`${trackId}:${expiresAt}`)
    .digest("hex");
}

function compareSignature(actual, expected) {
  if (!actual || !expected) return false;
  try {
    const a = Buffer.from(String(actual), "utf8");
    const b = Buffer.from(String(expected), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_error) {
    return false;
  }
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function buildSignedStreamUrl(req, trackId, expiresAt) {
  const baseUrl = getBaseUrl(req);
  const signature = createSignature(trackId, expiresAt);
  return `${baseUrl}/stream/${encodeURIComponent(trackId)}?exp=${expiresAt}&sig=${signature}`;
}

function validateSignedStream({ trackId, expRaw, sigRaw }) {
  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { valid: false, reason: "expired" };
  }

  const expected = createSignature(trackId, expiresAt);
  if (!compareSignature(sigRaw, expected)) {
    return { valid: false, reason: "signature_invalid" };
  }

  return { valid: true, expiresAt };
}

function upsertTrackCache(lookupKey, payload, ttlMs) {
  const ttl = Math.max(1000, Number(ttlMs) || RESOLVE_CACHE_TTL_MS);
  const merged = {
    ...payload,
    warmedChunk: payload.warmedChunk || null,
    warmedAt: payload.warmedAt || null,
    prefetchStatus: payload.prefetchStatus || "pending",
  };
  resolveCacheByLookup.set(lookupKey, merged.track_id, ttl);
  resolveCacheByTrackId.set(merged.track_id, merged, ttl);
  return merged;
}

function getTrackByLookupKey(lookupKey) {
  const trackId = resolveCacheByLookup.get(lookupKey);
  if (!trackId) return null;
  return resolveCacheByTrackId.get(trackId);
}

function getTrackById(trackId) {
  return resolveCacheByTrackId.get(trackId);
}

async function runYtDlpInfoWithRetry({ link, tipo }) {
  let lastError = null;

  for (let attempt = 0; attempt < YTDLP_MAX_RETRIES; attempt += 1) {
    const cookiePath = cookieManager.getCurrent();
    try {
      const infoRaw = await ytDlpWrap.execPromise([
        link,
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--format",
        tipo === "audio" ? "bestaudio/best" : "bestvideo+bestaudio/best",
        "--ignore-no-formats-error",
        ...buildCommonYtDlpArgs({ includeCookies: true, cookiePath }),
      ]);
      return JSON.parse(infoRaw);
    } catch (error) {
      lastError = error;
      const errorText = extractYtDlpErrorText(error);
      const shouldRotate = isRetryableAntiBotError(errorText);
      if (shouldRotate) {
        cookieManager.rotate("anti-bot");
      }

      if (attempt >= YTDLP_MAX_RETRIES - 1) {
        break;
      }

      const delay = YTDLP_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError || new Error("Falha ao obter metadados no yt-dlp");
}

function buildTrackPayloadFromInfo({ info, link, tipo, trackId = null }) {
  const preferredFormat = selectPreferredFormat(info, tipo);
  const streamUrl = preferredFormat?.url || info?.url || null;
  if (!streamUrl) {
    const error = new Error("Stream URL indisponivel para esse conteúdo");
    error.code = "STREAM_URL_UNAVAILABLE";
    throw error;
  }

  const upstreamExpireMs = parseExpireFromStreamUrl(streamUrl);
  const now = Date.now();
  const maxSignedExpiresAt = now + SIGNED_URL_TTL_MS;
  const expiresAt = Math.min(
    upstreamExpireMs || maxSignedExpiresAt,
    maxSignedExpiresAt,
  );

  return {
    track_id: trackId || crypto.randomUUID(),
    link,
    type: tipo,
    title: info?.title || "Sem titulo",
    duration: info?.duration || null,
    thumbnail: pickThumbnail(info),
    stream_source_url: streamUrl,
    stream_source_expires_at: upstreamExpireMs || null,
    expires_at: expiresAt,
    mime_type: guessMimeTypeFromFormat(preferredFormat, tipo),
    format_id: preferredFormat?.format_id || null,
    warmedChunk: null,
    warmedAt: null,
    prefetchStatus: "pending",
  };
}

async function resolveTrackEntry({ link, type, lookupKey }) {
  const tipo = normalizeResolveType(type);
  const info = await runYtDlpInfoWithRetry({ link, tipo });
  const payload = buildTrackPayloadFromInfo({ info, link, tipo });
  const ttlFromExpire = Math.max(1000, payload.expires_at - Date.now());
  const ttl = Math.min(RESOLVE_CACHE_TTL_MS, ttlFromExpire);
  return upsertTrackCache(lookupKey, payload, ttl);
}

function needsResolveRefresh(track) {
  if (!track) return true;
  const now = Date.now();
  return !track.stream_source_url || track.expires_at <= now + 15000;
}

async function refreshTrackIfNeeded(track) {
  if (!needsResolveRefresh(track)) {
    return track;
  }

  const lookupKey = createResolveLookupKey(track.link, track.type);
  const info = await runYtDlpInfoWithRetry({
    link: track.link,
    tipo: normalizeResolveType(track.type),
  });
  const refreshed = buildTrackPayloadFromInfo({
    info,
    link: track.link,
    tipo: normalizeResolveType(track.type),
    trackId: track.track_id,
  });
  const ttlFromExpire = Math.max(1000, refreshed.expires_at - Date.now());
  const ttl = Math.min(RESOLVE_CACHE_TTL_MS, ttlFromExpire);
  return upsertTrackCache(lookupKey, refreshed, ttl);
}

async function warmTrack(trackId) {
  const track = getTrackById(trackId);
  if (!track) {
    const error = new Error("track_id não encontrado");
    error.code = "TRACK_NOT_FOUND";
    throw error;
  }

  const refreshed = await refreshTrackIfNeeded(track);
  if (!refreshed.stream_source_url) {
    const error = new Error("URL de stream indisponivel");
    error.code = "STREAM_URL_UNAVAILABLE";
    throw error;
  }

  const warmed = await fetchWarmupChunk(refreshed.stream_source_url, {
    bytes: WARM_CHUNK_BYTES,
    timeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
  });

  const updated = {
    ...refreshed,
    warmedChunk: warmed,
    warmedAt: Date.now(),
    prefetchStatus: "ready",
  };

  const lookupKey = createResolveLookupKey(updated.link, updated.type);
  const ttlFromExpire = Math.max(1000, updated.expires_at - Date.now());
  const ttl = Math.min(RESOLVE_CACHE_TTL_MS, ttlFromExpire);
  upsertTrackCache(lookupKey, updated, ttl);

  prefetchStatusCache.set(trackId, {
    status: "ready",
    track_id: trackId,
    updated_at: Date.now(),
    bytes_warmed: warmed.bytes,
  });

  return updated;
}

function respondRateLimit(res, message, limitInfo) {
  return res.status(429).json({
    sucesso: false,
    mensagem: message,
    limite: {
      chave: limitInfo.key,
      ativos: limitInfo.active,
      limite: limitInfo.limit,
    },
  });
}

function shouldUseWarmChunk(track, req) {
  if (!track || !track.warmedChunk || req.headers.range) {
    return false;
  }
  if (!track.warmedAt) return false;
  return Date.now() - track.warmedAt <= WARM_CHUNK_TTL_MS;
}

function streamAsOpus({ req, res, track, onFirstByte }) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-loglevel",
      "error",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2",
      "-i",
      track.stream_source_url,
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      OPUS_BITRATE,
      "-f",
      "opus",
      "pipe:1",
    ];

    const ffmpeg = require("child_process").spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let firstByteSent = false;
    const markFirstByte = () => {
      if (firstByteSent) return;
      firstByteSent = true;
      if (typeof onFirstByte === "function") {
        onFirstByte();
      }
    };

    res.status(200);
    res.setHeader("content-type", "audio/ogg; codecs=opus");
    res.setHeader("transfer-encoding", "chunked");

    ffmpeg.stdout.on("data", () => {
      markFirstByte();
    });

    ffmpeg.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) {
        stderr += chunk.toString();
      }
    });

    ffmpeg.on("error", (error) => {
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        if (!res.writableEnded) {
          res.end();
        }
        return resolve();
      }

      const error = new Error(
        `FFmpeg falhou com codigo ${code}. ${stderr || ""}`.trim(),
      );
      reject(error);
    });

    req.on("close", () => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGTERM");
      }
    });

    ffmpeg.stdout.pipe(res, { end: false });
  });
}

function streamLocalFileWithRange(req, res, caminho, contentType = "video/mp4") {
  if (!fs.existsSync(caminho)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: "❌ Arquivo não encontrado.",
    });
  }

  const stat = fs.statSync(caminho);
  const range = String(req.headers.range || "").trim();

  if (!range) {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(caminho).pipe(res);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) {
    res.writeHead(416, {
      "Content-Range": `bytes */${stat.size}`,
      "Accept-Ranges": "bytes",
    });
    res.end();
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= stat.size
  ) {
    res.writeHead(416, {
      "Content-Range": `bytes */${stat.size}`,
      "Accept-Ranges": "bytes",
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
  });

  fs.createReadStream(caminho, { start, end }).pipe(res);
}

// ==================== ROTAS ====================

// Health check
app.get("/", (req, res) => {
  res.json({ status: "API yt-dlp online 🚀" });
});

/**
 * Busca vídeos por nome
 */
app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O parâmetro 'q' é obrigatório.",
    });
  }

  try {
    const infoRaw = await ytDlpWrap.execPromise([
      `ytsearch1:${query}`,
      "--dump-single-json",
      "--skip-download",
      "--flat-playlist",
      "--no-warnings",
    ]);
    const info = JSON.parse(infoRaw);
    const primeiro =
      info.entries && info.entries.length > 0 ? info.entries[0] : null;

    return res.json({
      sucesso: true,
      total: primeiro ? 1 : 0,
      resultado: primeiro,
    });
  } catch (erro) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Erro ao buscar vídeos.",
      erro: erro.message,
    });
  }
});

/**
 * Resolve rápido (sem download)
 */
app.post("/resolve", async (req, res) => {
  const startedAt = Date.now();
  const link = String(req.body?.link || "").trim();
  const tipo = normalizeResolveType(req.body?.type);
  const lookupKey = createResolveLookupKey(link, tipo);
  const guildId = getGuildIdFromRequest(req) || "anonymous";
  const ip = getClientIp(req);

  if (!link) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O campo 'link' é obrigatório.",
    });
  }

  if (!isYoutubeLink(link)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O link informado não é do YouTube.",
    });
  }

  const ipLease = resolveIpLimiter.tryAcquire(ip);
  if (!ipLease.acquired) {
    return respondRateLimit(
      res,
      "❌ Limite de resolves simultâneos por IP atingido.",
      ipLease,
    );
  }

  const guildLease = resolveGuildLimiter.tryAcquire(guildId);
  if (!guildLease.acquired) {
    resolveIpLimiter.release(ip);
    return respondRateLimit(
      res,
      "❌ Limite de resolves simultâneos por guild atingido.",
      guildLease,
    );
  }

  try {
    let cacheHit = false;
    let entry = getTrackByLookupKey(lookupKey);

    if (entry && !needsResolveRefresh(entry)) {
      cacheHit = true;
      metrics.increment("resolve_cache_hit", 1);
    } else if (entry) {
      entry = await resolveWorkerPool.run(() => refreshTrackIfNeeded(entry));
    } else {
      entry = await resolveWorkerPool.run(() =>
        resolveTrackEntry({ link, type: tipo, lookupKey }),
      );
    }

    const streamUrl = buildSignedStreamUrl(req, entry.track_id, entry.expires_at);
    metrics.observe("resolve_ms", Date.now() - startedAt);

    return res.json({
      sucesso: true,
      track_id: entry.track_id,
      title: entry.title,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      stream_url: streamUrl,
      expires_at: entry.expires_at,
      cache_hit: cacheHit,
    });
  } catch (error) {
    const errorText = extractYtDlpErrorText(error);
    const blockedByBot = isYoutubeBotCheckError(errorText);
    console.error(`❌ Resolve falhou | link=${link} | erro=${errorText}`);

    if (error?.code === "WORKER_POOL_QUEUE_FULL") {
      return res.status(429).json({
        sucesso: false,
        mensagem: "❌ Fila de resolve cheia. Tente novamente em instantes.",
      });
    }

    if (blockedByBot) {
      return res.status(403).json({
        sucesso: false,
        mensagem: "❌ O YouTube solicitou verificação anti-bot.",
      });
    }

    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Falha ao resolver stream.",
      erro: error.message,
    });
  } finally {
    resolveIpLimiter.release(ip);
    resolveGuildLimiter.release(guildId);
  }
});

/**
 * Prefetch dos próximos tracks
 */
app.post("/prefetch", async (req, res) => {
  const trackIdsRaw = req.body?.track_ids;
  const trackIds = Array.isArray(trackIdsRaw)
    ? trackIdsRaw.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const guildId = getGuildIdFromRequest(req) || "anonymous";
  const ip = getClientIp(req);

  if (!trackIds.length) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O campo 'track_ids' deve ser um array não vazio.",
    });
  }

  const ipLease = prefetchIpLimiter.tryAcquire(ip);
  if (!ipLease.acquired) {
    return respondRateLimit(
      res,
      "❌ Limite de prefetch simultâneo por IP atingido.",
      ipLease,
    );
  }

  const guildLease = prefetchGuildLimiter.tryAcquire(guildId);
  if (!guildLease.acquired) {
    prefetchIpLimiter.release(ip);
    return respondRateLimit(
      res,
      "❌ Limite de prefetch simultâneo por guild atingido.",
      guildLease,
    );
  }

  try {
    const uniqueTrackIds = Array.from(new Set(trackIds));
    const accepted = [];
    const failed = [];

    for (const trackId of uniqueTrackIds) {
      const track = getTrackById(trackId);
      if (!track) {
        prefetchStatusCache.set(trackId, {
          status: "failed",
          track_id: trackId,
          updated_at: Date.now(),
          erro: "track_id não encontrado",
        });
        failed.push({
          track_id: trackId,
          status: "failed",
          erro: "track_id não encontrado",
        });
        continue;
      }

      prefetchStatusCache.set(trackId, {
        status: "pending",
        track_id: trackId,
        updated_at: Date.now(),
      });

      accepted.push({ track_id: trackId, status: "pending" });

      prefetchWorkerPool
        .run(async () => {
          try {
            await warmTrack(trackId);
          } catch (error) {
            prefetchStatusCache.set(trackId, {
              status: "failed",
              track_id: trackId,
              updated_at: Date.now(),
              erro: error.message,
            });
            throw error;
          }
        })
        .catch((error) => {
          if (error?.code === "WORKER_POOL_QUEUE_FULL") {
            prefetchStatusCache.set(trackId, {
              status: "failed",
              track_id: trackId,
              updated_at: Date.now(),
              erro: "fila de prefetch cheia",
            });
            return;
          }
          console.warn(
            `⚠️ Prefetch falhou | track_id=${trackId} | erro=${error.message}`,
          );
        });
    }

    return res.status(202).json({
      sucesso: true,
      accepted,
      failed,
    });
  } finally {
    prefetchIpLimiter.release(ip);
    prefetchGuildLimiter.release(guildId);
  }
});

/**
 * Status do prefetch
 */
app.get("/prefetch/status/:trackId", (req, res) => {
  const trackId = String(req.params.trackId || "").trim();
  if (!trackId) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O parâmetro 'trackId' é obrigatório.",
    });
  }

  const status = prefetchStatusCache.get(trackId);
  if (!status) {
    const track = getTrackById(trackId);
    if (!track) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "❌ track_id não encontrado.",
      });
    }

    return res.json({
      sucesso: true,
      track_id: trackId,
      status: track.prefetchStatus || "pending",
    });
  }

  return res.json({
    sucesso: true,
    ...status,
  });
});

/**
 * Métricas internas
 */
app.get("/metrics", (req, res) => {
  const snapshot = metrics.snapshot();
  return res.json({
    ...snapshot,
    pools: {
      resolve: resolveWorkerPool.getStats(),
      prefetch: prefetchWorkerPool.getStats(),
    },
    caches: {
      resolve_lookup: resolveCacheByLookup.size,
      resolve_track: resolveCacheByTrackId.size,
      prefetch_status: prefetchStatusCache.size,
    },
    cookies: cookieManager.getStats(),
  });
});

/**
 * Inicia download
 */
app.post("/download", async (req, res) => {
  try {
    const requestIdForQueue = String(req.body?.request_id || "").trim();
    let queueAhead = 0;
    let queueStatsAtStart = null;
    await downloadSemaphore.run(
      async ({ queueAhead: ahead, queueStats }) => {
        queueAhead = ahead;
        queueStatsAtStart = queueStats;
        const { link, type, request_id: requestIdRaw } = req.body;
        const requestId = String(requestIdRaw || "").trim();

        console.log(
          `➡️ Requisicao download recebida | request_id=${requestId || "vazio"} | link=${link || "vazio"} | type=${type || "video"}`,
        );
        console.log(
          `⏳ Posicao na fila | request_id=${requestId || "vazio"} | downloads_a_frente=${queueAhead}`,
        );

        if (!link) {
          console.warn("⚠️ Download rejeitado: link ausente");
          return res.status(400).json({
            sucesso: false,
            mensagem: "❌ O campo 'link' é obrigatório.",
          });
        }

        if (!requestId) {
          console.warn("⚠️ Download rejeitado: request_id ausente");
          return res.status(400).json({
            sucesso: false,
            mensagem: "❌ O campo 'request_id' é obrigatório.",
          });
        }

        if (!isValidRequestId(requestId)) {
          console.warn("⚠️ Download rejeitado: request_id invalido");
          return res.status(400).json({
            sucesso: false,
            mensagem:
              "❌ O 'request_id' deve conter apenas letras, números, '_' ou '-'.",
          });
        }

        if (!isYoutubeLink(link)) {
          console.warn("⚠️ Download rejeitado: link nao e YouTube");
          return res.status(400).json({
            sucesso: false,
            mensagem: "❌ O link informado não é do YouTube.",
          });
        }

        const activeCookiePath = cookieManager.getCurrent() || COOKIES_PATH;

        if (!fs.existsSync(YTDLP_BINARY_PATH)) {
          console.error("❌ yt-dlp nao encontrado");
          return res.status(500).json({
            sucesso: false,
            mensagem: "❌ yt-dlp não encontrado. Execute o install.js.",
          });
        }

        if (!activeCookiePath || !fs.existsSync(activeCookiePath)) {
          console.error("❌ cookies.txt nao encontrado");
          return res.status(500).json({
            sucesso: false,
            mensagem: "❌ Arquivo cookies.txt não encontrado.",
          });
        }

        const cookiesDiagnostics = analyzeCookiesFile(activeCookiePath);
        if (cookiesDiagnostics.readError) {
          console.error(
            `❌ Falha ao ler cookies.txt | request_id=${requestId} | erro=${cookiesDiagnostics.readError}`,
          );
          return res.status(500).json({
            sucesso: false,
            mensagem: "❌ Não foi possível ler o arquivo cookies.txt.",
            erro: cookiesDiagnostics.readError,
          });
        }

        if (
          cookiesDiagnostics.totalCookies === 0 ||
          !cookiesDiagnostics.hasYoutubeDomain
        ) {
          console.error(
            `❌ cookies.txt invalido | request_id=${requestId} | total=${cookiesDiagnostics.totalCookies} | youtube_domain=${cookiesDiagnostics.hasYoutubeDomain}`,
          );
          return res.status(500).json({
            sucesso: false,
            mensagem:
              "❌ cookies.txt inválido. Exporte novamente no formato Netscape com sessão ativa no YouTube.",
            diagnostico: {
              total_cookies: cookiesDiagnostics.totalCookies,
              tem_dominio_youtube: cookiesDiagnostics.hasYoutubeDomain,
            },
          });
        }

        if (!cookiesDiagnostics.hasAuthCookie) {
          console.warn(
            `⚠️ cookies sem autenticacao forte | request_id=${requestId} | auth_detectados=0`,
          );
        }

        const tipoSaida = type === "audio" ? "audio" : "video";
        console.log(
          `⬇️ Iniciando download | request_id=${requestId} | tipo=${tipoSaida} | link=${link}`,
        );

        let arquivoFinal = null;
        let videoInfo = null;
        let processoErro = null;
        let metadataBlockedByBotCheck = false;

        try {
          const requestDir = path.join(DOWNLOADS_DIR, requestId);
          if (!fs.existsSync(requestDir)) {
            fs.mkdirSync(requestDir, { recursive: true });
          }

          try {
            console.log(
              `🔎 Buscando metadados | request_id=${requestId} | link=${link}`,
            );
            const infoRaw = await ytDlpWrap.execPromise([
              link,
              "--dump-single-json",
              "--skip-download",
              "--no-playlist",
              "--ignore-no-formats-error",
              ...buildCommonYtDlpArgs(),
            ]);
            videoInfo = JSON.parse(infoRaw);
            console.log(
              `✅ Metadados obtidos | request_id=${requestId} | titulo=${videoInfo?.title || "desconhecido"}`,
            );
          } catch (infoErro) {
            const infoErroTexto = extractYtDlpErrorText(infoErro);
            metadataBlockedByBotCheck = isYoutubeBotCheckError(infoErroTexto);
            console.warn(
              `⚠️ Não foi possível obter metadados do vídeo | request_id=${requestId} | bloqueio_anti_bot=${metadataBlockedByBotCheck} | erro=${infoErroTexto}`,
            );
          }

          const outputTemplate = path.join(requestDir, "%(title)s.%(ext)s");
          const downloadArgsBase = [
            // Template de saída (NÃO adivinhamos nome)
            "-o",
            outputTemplate,

            // Retorna o caminho real do arquivo final
            "--print",
            "after_postprocess:%(filepath)s",
            "--print",
            "after_move:%(filepath)s",

            "--max-filesize",
            MAX_DOWNLOAD_LABEL,
          ];

          if (tipoSaida === "audio") {
            downloadArgsBase.push("-x", "--audio-format", "mp3");
          } else {
            downloadArgsBase.push("-f", VIDEO_FORMAT, "--merge-output-format", "mp4");
          }

          const executeDownloadAttempt = async ({
            includeCookies,
            attemptLabel,
          }) => {
            let localArquivoFinal = null;
            let localProcessoErro = null;
            const attemptStartedAt = Date.now();
            const args = [
              link,
              ...buildCommonYtDlpArgs({ includeCookies }),
              ...downloadArgsBase,
            ];

            console.log(
              `🚀 Executando yt-dlp | request_id=${requestId} | tipo=${tipoSaida} | tentativa=${attemptLabel} | cookies=${includeCookies}`,
            );

            const processo = ytDlpWrap.exec(args);

            processo.on("progress", (p) => {
              console.log(
                `📥 Progresso | request_id=${requestId} | tentativa=${attemptLabel} | ${p.percent || 0}%`,
              );
            });

            processo.on("ytDlpEvent", (eventType, data) => {
              if (eventType === "after_postprocess" || eventType === "after_move") {
                localArquivoFinal = data.trim();
                console.log(
                  `📁 Arquivo final | request_id=${requestId} | tentativa=${attemptLabel} | path=${localArquivoFinal}`,
                );
              }
            });

            processo.on("error", (erro) => {
              localProcessoErro = extractYtDlpErrorText(erro);
              console.error(
                `❌ Erro yt-dlp | request_id=${requestId} | tentativa=${attemptLabel} | ${localProcessoErro}`,
              );
            });

            const resolveOutputByDirectoryFallback = () => {
              if (!localArquivoFinal || !fs.existsSync(localArquivoFinal)) {
                const arquivos = fs
                  .readdirSync(requestDir)
                  .map((nome) => {
                    const fullPath = path.join(requestDir, nome);
                    const stat = fs.statSync(fullPath);
                    return { fullPath, mtimeMs: stat.mtimeMs };
                  })
                  .sort((a, b) => b.mtimeMs - a.mtimeMs);

                const recentes = arquivos.filter(
                  (item) => item.mtimeMs >= attemptStartedAt - 5000,
                );

                if (recentes.length > 0) {
                  localArquivoFinal = recentes[0].fullPath;
                  console.log(
                    `📁 Arquivo final (fallback) | request_id=${requestId} | tentativa=${attemptLabel} | path=${localArquivoFinal}`,
                  );
                } else if (arquivos.length > 0) {
                  localArquivoFinal = arquivos[0].fullPath;
                  console.log(
                    `📁 Arquivo final (fallback) | request_id=${requestId} | tentativa=${attemptLabel} | path=${localArquivoFinal}`,
                  );
                } else {
                  console.error(
                    `❌ Download finalizou mas arquivo não encontrado | request_id=${requestId} | tentativa=${attemptLabel}`,
                  );
                }
              }
            };

            // Em alguns erros o yt-dlp-wrap pode emitir "error" sem emitir "close".
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                resolveOutputByDirectoryFallback();
                resolve();
              };

              processo.once("close", finish);
              processo.once("error", () => {
                setTimeout(finish, 250);
              });
            });

            return {
              arquivoFinal: localArquivoFinal,
              processoErro: localProcessoErro,
            };
          };

          let requestedFormatUnavailableWithCookies = false;
          let requestedFormatUnavailableWithoutCookies = false;
          let retryWithoutCookiesBlockedByBot = false;

          const firstAttempt = await executeDownloadAttempt({
            includeCookies: true,
            attemptLabel: "com_cookies",
          });
          arquivoFinal = firstAttempt.arquivoFinal;
          processoErro = firstAttempt.processoErro;
          requestedFormatUnavailableWithCookies =
            isRequestedFormatUnavailableError(processoErro);

          if (
            (!arquivoFinal || !fs.existsSync(arquivoFinal)) &&
            requestedFormatUnavailableWithCookies
          ) {
            console.warn(
              `⚠️ Nenhum formato disponivel com cookies | request_id=${requestId} | tentando sem cookies`,
            );
            const secondAttempt = await executeDownloadAttempt({
              includeCookies: false,
              attemptLabel: "sem_cookies",
            });

            if (secondAttempt.arquivoFinal && fs.existsSync(secondAttempt.arquivoFinal)) {
              arquivoFinal = secondAttempt.arquivoFinal;
              processoErro = secondAttempt.processoErro;
            } else {
              processoErro = secondAttempt.processoErro || processoErro;
              requestedFormatUnavailableWithoutCookies =
                isRequestedFormatUnavailableError(secondAttempt.processoErro);
              retryWithoutCookiesBlockedByBot = isYoutubeBotCheckError(
                secondAttempt.processoErro,
              );
            }
          }

          if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
            const semFormatoDisponivel =
              isRequestedFormatUnavailableError(processoErro) ||
              requestedFormatUnavailableWithCookies ||
              requestedFormatUnavailableWithoutCookies;
            if (
              semFormatoDisponivel &&
              requestedFormatUnavailableWithCookies &&
              retryWithoutCookiesBlockedByBot
            ) {
              console.warn(
                `⚠️ Sem formatos com cookies e sem cookies bloqueado por anti-bot | request_id=${requestId}`,
              );
              return res.status(403).json({
                sucesso: false,
                mensagem:
                  "❌ Não foi possível obter formatos de mídia deste vídeo no momento.",
                erro:
                  "Com os cookies atuais o YouTube não retorna formatos de áudio/vídeo, e sem cookies ele exige verificação anti-bot.",
                diagnostico: {
                  request_id: requestId,
                  cookie_path: activeCookiePath,
                  cookies_auth_detectados: cookiesDiagnostics.authCookieNames,
                  dica:
                    "Exporte novamente o cookies.txt de uma sessão ativa e teste de novo.",
                },
              });
            }

            if (semFormatoDisponivel) {
              console.warn(
                `⚠️ Nenhum formato de midia disponivel | request_id=${requestId}`,
              );
              return res.status(422).json({
                sucesso: false,
                mensagem:
                  "❌ O YouTube não disponibilizou formatos de mídia compatíveis para este vídeo.",
                erro:
                  "Requested format is not available. Atualize o cookies.txt e tente novamente.",
              });
            }

            const bloqueioAntiBot =
              isYoutubeBotCheckError(processoErro) || metadataBlockedByBotCheck;
            if (bloqueioAntiBot) {
              console.warn(
                `⚠️ Bloqueio anti-bot do YouTube | request_id=${requestId}`,
              );
              return res.status(403).json({
                sucesso: false,
                mensagem:
                  "❌ O YouTube solicitou verificação anti-bot para este vídeo.",
                erro:
                  "Renove o cookies.txt com conta logada e exporte novamente em formato Netscape.",
                diagnostico: {
                  request_id: requestId,
                  cookie_path: activeCookiePath,
                  cookies_auth_detectados: cookiesDiagnostics.authCookieNames,
                  dica:
                    "Use a extensão 'Get cookies.txt (LOCALLY)' no navegador já logado no YouTube e substitua o arquivo.",
                },
              });
            }

            const excedeuLimite =
              processoErro &&
              /max-filesize|file is larger than/i.test(processoErro);
            if (excedeuLimite) {
              console.warn(
                `⚠️ Download excedeu limite | request_id=${requestId}`,
              );
              return res.status(413).json({
                sucesso: false,
                mensagem: "❌ Arquivo excede o limite de 100MB.",
              });
            }

            console.error(
              `❌ Download finalizou sem arquivo | request_id=${requestId}`,
            );
            return res.status(500).json({
              sucesso: false,
              mensagem:
                "❌ Download finalizou, mas o arquivo não foi localizado.",
            });
          }

          try {
            console.log(
              `🎛️ Convertendo midia | request_id=${requestId} | tipo=${tipoSaida}`,
            );
            const convertido = await convertMedia(
              tipoSaida,
              arquivoFinal,
              requestDir,
            );
            if (convertido && convertido !== arquivoFinal) {
              try {
                fs.unlinkSync(arquivoFinal);
              } catch (erro) {
                console.warn(
                  `⚠️ Falha ao remover arquivo original | request_id=${requestId} | ${erro.message}`,
                );
              }
              arquivoFinal = convertido;
            }
            console.log(
              `✅ Conversao concluida | request_id=${requestId} | path=${arquivoFinal}`,
            );
          } catch (erro) {
            console.error(
              `❌ Erro ao converter midia | request_id=${requestId} | ${erro.message}`,
            );
            return res.status(500).json({
              sucesso: false,
              mensagem: "❌ Falha ao converter a mídia.",
              erro: erro.message,
            });
          }

          const tamanhoFinal = fs.statSync(arquivoFinal).size;
          if (tamanhoFinal > MAX_DOWNLOAD_BYTES) {
            console.warn(
              `⚠️ Arquivo acima do limite | request_id=${requestId} | bytes=${tamanhoFinal}`,
            );
            fs.unlinkSync(arquivoFinal);
            return res.status(413).json({
              sucesso: false,
              mensagem: "❌ Arquivo excede o limite de 100MB.",
            });
          }

          if (tipoSaida === "video") {
            const temAudio = await hasAudioStream(arquivoFinal);
            if (!temAudio) {
              console.error(
                `❌ Video sem audio | request_id=${requestId} | path=${arquivoFinal}`,
              );
              return res.status(500).json({
                sucesso: false,
                mensagem: "❌ O vídeo baixado não contém faixa de áudio.",
              });
            }
          }

          const nomeArquivo = path.basename(arquivoFinal);
          console.log(
            `✅ Download concluido | request_id=${requestId} | arquivo=${nomeArquivo} | bytes=${tamanhoFinal}`,
          );

          const contentType =
            tipoSaida === "audio" ? "audio/mpeg" : "video/mp4";
          return streamFileResponse(
            res,
            arquivoFinal,
            contentType,
            {
              "X-Queue-Ahead": String(queueAhead),
              "X-Queue-Limit": String(queueStatsAtStart?.limit || ""),
              "X-Request-Id": requestId,
            },
            { deleteAfterSend: true, cleanupDir: requestDir },
          );
        } catch (erro) {
          console.error(
            `❌ Erro ao executar yt-dlp | request_id=${requestId} | ${erro.message}`,
          );
          return res.status(500).json({
            sucesso: false,
            mensagem: "❌ Erro ao executar yt-dlp.",
            erro: erro.message,
          });
        }
      },
      { requestId: requestIdForQueue },
    );
  } catch (erro) {
    if (erro && erro.code === "QUEUE_FULL") {
      console.warn("⚠️ Fila cheia: recusando requisicao");
      return res.status(429).json({
        sucesso: false,
        mensagem: "❌ Fila de downloads cheia. Tente novamente mais tarde.",
        fila: {
          downloads_a_frente: erro?.stats?.active ?? null,
          enfileirados: erro?.stats?.queued ?? null,
          limite_concorrencia: erro?.stats?.limit ?? null,
          limite_fila: erro?.stats?.maxQueue ?? null,
        },
      });
    }

    console.error(`❌ Erro ao enfileirar download | ${erro.message}`);
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Erro ao enfileirar o download.",
      erro: erro.message,
    });
  }
});

/**
 * Status da fila por request_id
 */
app.get("/download/queue-status/:requestId", (req, res) => {
  const requestId = String(req.params.requestId || "").trim();
  if (!requestId) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O parâmetro 'requestId' é obrigatório.",
    });
  }

  const info = downloadSemaphore.getQueueInfo(requestId);
  if (!info) {
    return res.status(404).json({
      sucesso: false,
      mensagem: "❌ request_id não encontrado na fila.",
    });
  }

  return res.json({
    sucesso: true,
    request_id: requestId,
    fila: {
      status: info.status,
      downloads_a_frente: info.downloads_a_frente,
      posicao_na_fila: info.posicao_na_fila ?? null,
      enfileirados: info.enfileirados,
      limite_concorrencia: downloadSemaphore.getStats().limit,
      limite_fila: downloadSemaphore.getStats().maxQueue,
    },
  });
});

/**
 * Streaming por track_id resolvido ou arquivo local (fallback)
 */
app.get("/stream/:trackId", async (req, res) => {
  const trackId = decodeURIComponent(req.params.trackId || "").trim();
  if (!trackId) {
    return res.status(400).json({
      sucesso: false,
      mensagem: "❌ O parâmetro 'trackId' é obrigatório.",
    });
  }

  const cachedTrack = getTrackById(trackId);
  if (!cachedTrack) {
    // Compatibilidade com rota antiga: /stream/:arquivo
    const caminho = path.join(DOWNLOADS_DIR, trackId);
    return streamLocalFileWithRange(req, res, caminho, "video/mp4");
  }

  const signatureValidation = validateSignedStream({
    trackId,
    expRaw: req.query.exp,
    sigRaw: req.query.sig,
  });
  if (!signatureValidation.valid) {
    return res.status(401).json({
      sucesso: false,
      mensagem: "❌ URL de stream inválida ou expirada.",
      motivo: signatureValidation.reason,
    });
  }

  const ip = getClientIp(req);
  const guildId = getGuildIdFromRequest(req) || "anonymous";

  const ipLease = streamIpLimiter.tryAcquire(ip);
  if (!ipLease.acquired) {
    return respondRateLimit(
      res,
      "❌ Limite de streams simultâneos por IP atingido.",
      ipLease,
    );
  }

  const guildLease = streamGuildLimiter.tryAcquire(guildId);
  if (!guildLease.acquired) {
    streamIpLimiter.release(ip);
    return respondRateLimit(
      res,
      "❌ Limite de streams simultâneos por guild atingido.",
      guildLease,
    );
  }

  const streamStartedAt = Date.now();

  try {
    const refreshedTrack = await refreshTrackIfNeeded(cachedTrack);
    const shouldTranscodeToOpus =
      !req.headers.range &&
      (ENABLE_OPUS_TRANSCODE ||
        String(req.query.transcode || "").toLowerCase() === "opus");

    if (shouldTranscodeToOpus) {
      await streamAsOpus({
        req,
        res,
        track: refreshedTrack,
        onFirstByte: () => {
          metrics.observe("stream_start_ms", Date.now() - streamStartedAt);
        },
      });
      return;
    }

    const warmChunk = shouldUseWarmChunk(refreshedTrack, req)
      ? refreshedTrack.warmedChunk
      : null;

    await proxyRemoteStream({
      req,
      res,
      streamUrl: refreshedTrack.stream_source_url,
      timeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
      warmChunk,
      onFirstByte: () => {
        metrics.observe("stream_start_ms", Date.now() - streamStartedAt);
      },
    });
  } catch (error) {
    console.error(`❌ Stream falhou | track_id=${trackId} | erro=${error.message}`);

    if (!res.headersSent) {
      return res.status(502).json({
        sucesso: false,
        mensagem: "❌ Falha ao iniciar stream.",
        erro: error.message,
      });
    }

    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    streamIpLimiter.release(ip);
    streamGuildLimiter.release(guildId);
  }
});

/**
 * Streaming de vídeo por request_id (suporte a Range)
 */
app.get("/stream/:requestId/:arquivo", (req, res) => {
  const requestId = decodeURIComponent(req.params.requestId);
  const arquivo = decodeURIComponent(req.params.arquivo);
  const caminho = path.join(DOWNLOADS_DIR, requestId, arquivo);
  return streamLocalFileWithRange(req, res, caminho, "video/mp4");
});

// ==================== START ====================
app.listen(PORT, HOST, () => {
  console.log(`🚀 API rodando em http://${HOST}:${PORT}`);
});
