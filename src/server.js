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

function buildCommonYtDlpArgs({ includeCookies = true } = {}) {
  const args = [];
  if (includeCookies) {
    args.push("--cookies", COOKIES_PATH);
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

        const cookiesDiagnostics = analyzeCookiesFile(COOKIES_PATH);
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
                  cookie_path: COOKIES_PATH,
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
                  cookie_path: COOKIES_PATH,
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
