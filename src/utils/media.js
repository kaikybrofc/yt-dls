const path = require("path");
const { execFile, spawn } = require("child_process");

function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "default=nk=1:nw=1",
        filePath,
      ],
      (erro, stdout) => {
        if (erro) return resolve(false);
        resolve(stdout.trim().length > 0);
      },
    );
  });
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill("SIGKILL");
      const error = new Error("FFmpeg excedeu o tempo limite.");
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);

    proc.stderr.on("data", (chunk) => {
      if (stderr.length < 8000) {
        stderr += chunk.toString();
      }
    });

    proc.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`FFmpeg saiu com codigo ${code}.`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function createMediaConverter({ ffmpegSemaphore, convertTimeoutMs }) {
  async function convertMedia(tipoSaida, inputPath, requestDir) {
    return ffmpegSemaphore.run(async () => {
      const outputPath =
        tipoSaida === "audio"
          ? path.join(
              requestDir,
              `audio_${Date.now()}_${Math.random().toString(16).slice(2)}.mp3`,
            )
          : path.join(
              requestDir,
              `video_${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`,
            );

      const args =
        tipoSaida === "audio"
          ? [
              "-y",
              "-i",
              inputPath,
              "-vn",
              "-acodec",
              "libmp3lame",
              "-b:a",
              "128k",
              "-ar",
              "44100",
              "-ac",
              "2",
              outputPath,
            ]
          : [
              "-y",
              "-i",
              inputPath,
              "-vf",
              "scale='min(1280,iw)':-2",
              "-preset",
              "veryfast",
              "-crf",
              "28",
              "-c:v",
              "libx264",
              "-profile:v",
              "baseline",
              "-level",
              "3.1",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-movflags",
              "+faststart",
              outputPath,
            ];

      await runFfmpeg(args, convertTimeoutMs);
      return outputPath;
    });
  }

  return { convertMedia };
}

module.exports = {
  createMediaConverter,
  hasAudioStream,
};
