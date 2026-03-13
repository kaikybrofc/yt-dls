const path = require("path");

const HOST = "127.0.0.1";
const PORT = 3013;

const ROOT_DIR = path.resolve(__dirname, "..");
const YTDLP_BINARY_PATH = path.join(ROOT_DIR, "bin", "yt-dlp");
const COOKIES_PATH = path.join(ROOT_DIR, "cookies.txt");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");

const VIDEO_FORMAT = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_LABEL = "100M";
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_QUEUE_SIZE = 10;
const MAX_CONCURRENT_FFMPEG = Number.parseInt(
  process.env.MAX_CONCURRENT_FFMPEG || "1",
  10,
);
const CONVERT_TIMEOUT_MS = 300000;
const RESOLVE_CACHE_TTL_MS = Number.parseInt(
  process.env.RESOLVE_CACHE_TTL_MS || "120000",
  10,
);
const TRACK_CACHE_MAX = Number.parseInt(process.env.TRACK_CACHE_MAX || "1500", 10);
const SIGNED_URL_TTL_MS = Number.parseInt(
  process.env.SIGNED_URL_TTL_MS || "180000",
  10,
);
const SIGNED_URL_SECRET =
  process.env.SIGNED_URL_SECRET || "change-this-secret-in-production";
const WARM_CHUNK_BYTES = Number.parseInt(
  process.env.WARM_CHUNK_BYTES || "65536",
  10,
);
const WARM_CHUNK_TTL_MS = Number.parseInt(
  process.env.WARM_CHUNK_TTL_MS || "120000",
  10,
);
const RESOLVE_POOL_SIZE = Number.parseInt(
  process.env.RESOLVE_POOL_SIZE || "4",
  10,
);
const PREFETCH_POOL_SIZE = Number.parseInt(
  process.env.PREFETCH_POOL_SIZE || "2",
  10,
);
const POOL_QUEUE_SIZE = Number.parseInt(process.env.POOL_QUEUE_SIZE || "200", 10);
const MAX_ACTIVE_STREAMS_PER_IP = Number.parseInt(
  process.env.MAX_ACTIVE_STREAMS_PER_IP || "4",
  10,
);
const MAX_ACTIVE_STREAMS_PER_GUILD = Number.parseInt(
  process.env.MAX_ACTIVE_STREAMS_PER_GUILD || "6",
  10,
);
const MAX_ACTIVE_RESOLVES_PER_IP = Number.parseInt(
  process.env.MAX_ACTIVE_RESOLVES_PER_IP || "8",
  10,
);
const MAX_ACTIVE_RESOLVES_PER_GUILD = Number.parseInt(
  process.env.MAX_ACTIVE_RESOLVES_PER_GUILD || "16",
  10,
);
const YTDLP_MAX_RETRIES = Number.parseInt(
  process.env.YTDLP_MAX_RETRIES || "3",
  10,
);
const YTDLP_RETRY_BASE_DELAY_MS = Number.parseInt(
  process.env.YTDLP_RETRY_BASE_DELAY_MS || "350",
  10,
);
const COOKIE_REFRESH_INTERVAL_MS = Number.parseInt(
  process.env.COOKIE_REFRESH_INTERVAL_MS || "60000",
  10,
);
const UPSTREAM_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.UPSTREAM_REQUEST_TIMEOUT_MS || "20000",
  10,
);
const PREFETCH_QUEUE_MAX = Number.parseInt(
  process.env.PREFETCH_QUEUE_MAX || "200",
  10,
);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const ENABLE_OPUS_TRANSCODE = String(
  process.env.ENABLE_OPUS_TRANSCODE || "false",
).toLowerCase() === "true";
const OPUS_BITRATE = process.env.OPUS_BITRATE || "96k";

module.exports = {
  HOST,
  PORT,
  ROOT_DIR,
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
};
