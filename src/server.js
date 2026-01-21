const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");

const app = express();
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
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

// =======================================================

// Garante pasta de downloads
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Inicializa yt-dlp
const ytDlpWrap = new YTDlpWrap(YTDLP_BINARY_PATH);

// ==================== UTIL ====================
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

const downloadSemaphore = new Semaphore(
  MAX_CONCURRENT_DOWNLOADS,
  MAX_QUEUE_SIZE,
);
const ffmpegSemaphore = new Semaphore(MAX_CONCURRENT_FFMPEG, 0);

function isYoutubeLink(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}

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

function runFfmpeg(args, timeoutMs = CONVERT_TIMEOUT_MS) {
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

    await runFfmpeg(args);
    return outputPath;
  });
}

function streamFileResponse(
  res,
  filePath,
  contentType,
  extraHeaders = {},
  options = {},
) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
    ...extraHeaders,
  });

  const stream = fs.createReadStream(filePath);
  if (options.deleteAfterSend) {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.unlink(filePath, (erro) => {
        if (erro) {
          console.warn(`⚠️ Falha ao remover arquivo | ${erro.message}`);
          return;
        }
        if (options.cleanupDir) {
          fs.readdir(options.cleanupDir, (dirErro, entries) => {
            if (dirErro) return;
            if (entries.length === 0) {
              fs.rmdir(options.cleanupDir, (rmErro) => {
                if (rmErro) {
                  console.warn(
                    `⚠️ Falha ao remover pasta | ${rmErro.message}`,
                  );
                }
              });
            }
          });
        }
      });
    };

    res.on("finish", cleanup);
    res.on("close", cleanup);
  }
  stream.on("error", (erro) => {
    console.error(`❌ Erro ao ler arquivo | ${erro.message}`);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
  stream.pipe(res);
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

      if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) {
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

      if (!fs.existsSync(YTDLP_BINARY_PATH)) {
        console.error("❌ yt-dlp nao encontrado");
        return res.status(500).json({
          sucesso: false,
          mensagem: "❌ yt-dlp não encontrado. Execute o install.js.",
        });
      }

      if (!fs.existsSync(COOKIES_PATH)) {
        console.error("❌ cookies.txt nao encontrado");
        return res.status(500).json({
          sucesso: false,
          mensagem: "❌ Arquivo cookies.txt não encontrado.",
        });
      }

      const tipoSaida = type === "audio" ? "audio" : "video";
      console.log(
        `⬇️ Iniciando download | request_id=${requestId} | tipo=${tipoSaida} | link=${link}`,
      );

      let arquivoFinal = null;
      let videoInfo = null;
      let processoErro = null;
      const startedAt = Date.now();

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
            "--cookies",
            COOKIES_PATH,
            "--js-runtimes",
            "node",
            "--no-warnings",
          ]);
          videoInfo = JSON.parse(infoRaw);
          console.log(
            `✅ Metadados obtidos | request_id=${requestId} | titulo=${videoInfo?.title || "desconhecido"}`,
          );
        } catch (infoErro) {
          console.warn(
            "⚠️ Não foi possível obter metadados do vídeo:",
            infoErro.message,
          );
        }

        const args = [
          link,

          // Cookies e runtime JS
          "--cookies",
          COOKIES_PATH,
          "--js-runtimes",
          "node",

          // Template de saída (NÃO adivinhamos nome)
          "-o",
          path.join(requestDir, "%(title)s.%(ext)s"),

          // Retorna o caminho real do arquivo final
          "--print",
          "after_postprocess:%(filepath)s",
          "--print",
          "after_move:%(filepath)s",

          "--no-warnings",
          "--max-filesize",
          MAX_DOWNLOAD_LABEL,
        ];

        if (tipoSaida === "audio") {
          args.push("-x", "--audio-format", "mp3");
        } else {
          args.push("-f", VIDEO_FORMAT, "--merge-output-format", "mp4");
        }

        console.log(
          `🚀 Executando yt-dlp | request_id=${requestId} | tipo=${tipoSaida}`,
        );
        const processo = ytDlpWrap.exec(args);

        processo.on("progress", (p) => {
          console.log(
            `📥 Progresso | request_id=${requestId} | ${p.percent || 0}%`,
          );
        });

        processo.on("ytDlpEvent", (tipo, data) => {
          if (tipo === "after_postprocess" || tipo === "after_move") {
            arquivoFinal = data.trim();
            console.log(
              `📁 Arquivo final | request_id=${requestId} | path=${arquivoFinal}`,
            );
          }
        });

        processo.on("error", (erro) => {
          processoErro = erro.stderr || erro.message || null;
          console.error(
            `❌ Erro yt-dlp | request_id=${requestId} | ${processoErro}`,
          );
        });

        processo.on("close", () => {
          if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
            const arquivos = fs
              .readdirSync(requestDir)
              .map((nome) => {
                const fullPath = path.join(requestDir, nome);
                const stat = fs.statSync(fullPath);
                return { fullPath, mtimeMs: stat.mtimeMs };
              })
              .sort((a, b) => b.mtimeMs - a.mtimeMs);

            const recentes = arquivos.filter(
              (item) => item.mtimeMs >= startedAt - 60000,
            );

            if (recentes.length > 0) {
              arquivoFinal = recentes[0].fullPath;
              console.log(
                `📁 Arquivo final (fallback) | request_id=${requestId} | path=${arquivoFinal}`,
              );
            } else if (arquivos.length > 0) {
              arquivoFinal = arquivos[0].fullPath;
              console.log(
                `📁 Arquivo final (fallback) | request_id=${requestId} | path=${arquivoFinal}`,
              );
            } else {
              console.error(
                `❌ Download finalizou mas arquivo não encontrado | request_id=${requestId}`,
              );
            }
          }
        });

        // Aguarda finalizar
        await new Promise((resolve) => processo.on("close", resolve));

        if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
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
 * Streaming de vídeo (suporte a Range)
 */
app.get("/stream/:arquivo", (req, res) => {
  const arquivo = decodeURIComponent(req.params.arquivo);
  const caminho = path.join(DOWNLOADS_DIR, arquivo);

  if (!fs.existsSync(caminho)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: "❌ Arquivo não encontrado.",
    });
  }

  const stat = fs.statSync(caminho);
  const range = req.headers.range;

  if (range) {
    const [start, end] = range.replace(/bytes=/, "").split("-");
    const inicio = parseInt(start, 10);
    const fim = end ? parseInt(end, 10) : stat.size - 1;

    const stream = fs.createReadStream(caminho, {
      start: inicio,
      end: fim,
    });

    res.writeHead(206, {
      "Content-Range": `bytes ${inicio}-${fim}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": fim - inicio + 1,
      "Content-Type": "video/mp4",
    });

    stream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "video/mp4",
    });

    fs.createReadStream(caminho).pipe(res);
  }
});

/**
 * Streaming de vídeo por request_id (suporte a Range)
 */
app.get("/stream/:requestId/:arquivo", (req, res) => {
  const requestId = decodeURIComponent(req.params.requestId);
  const arquivo = decodeURIComponent(req.params.arquivo);
  const caminho = path.join(DOWNLOADS_DIR, requestId, arquivo);

  if (!fs.existsSync(caminho)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: "❌ Arquivo não encontrado.",
    });
  }

  const stat = fs.statSync(caminho);
  const range = req.headers.range;

  if (range) {
    const [start, end] = range.replace(/bytes=/, "").split("-");
    const inicio = parseInt(start, 10);
    const fim = end ? parseInt(end, 10) : stat.size - 1;

    const stream = fs.createReadStream(caminho, {
      start: inicio,
      end: fim,
    });

    res.writeHead(206, {
      "Content-Range": `bytes ${inicio}-${fim}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": fim - inicio + 1,
      "Content-Type": "video/mp4",
    });

    stream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "video/mp4",
    });

    fs.createReadStream(caminho).pipe(res);
  }
});

// ==================== START ====================
app.listen(PORT, HOST, () => {
  console.log(`🚀 API rodando em http://${HOST}:${PORT}`);
});
