const path = require("path");

const HOST = "127.0.0.1";
const PORT = 3000;

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
};
