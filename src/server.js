const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
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
} = require("./config");
const { Semaphore } = require("./utils/semaphore");
const { isYoutubeLink, isValidRequestId } = require("./utils/validators");
const { createMediaConverter, hasAudioStream } = require("./utils/media");
const { streamFileResponse } = require("./utils/stream");

const app = express();
app.use(express.json());

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
