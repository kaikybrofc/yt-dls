const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const app = express();
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const HOST = "127.0.0.1";
const PORT = 3000;

const ROOT_DIR = path.resolve(__dirname, "..");
const YTDLP_BINARY_PATH = path.join(ROOT_DIR, "bin", "yt-dlp");
const COOKIES_PATH = path.join(ROOT_DIR, "cookies.txt");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const VIDEO_FORMAT =
  "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_LABEL = "100M";

// =======================================================

// Garante pasta de downloads
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Inicializa yt-dlp
const ytDlpWrap = new YTDlpWrap(YTDLP_BINARY_PATH);

// ==================== UTIL ====================
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
      }
    );
  });
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
    const primeiro = info.entries && info.entries.length > 0 ? info.entries[0] : null;

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
  const { link, type } = req.body;

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

  if (!fs.existsSync(YTDLP_BINARY_PATH)) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ yt-dlp não encontrado. Execute o install.js.",
    });
  }

  if (!fs.existsSync(COOKIES_PATH)) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Arquivo cookies.txt não encontrado.",
    });
  }

  const tipoSaida = type === "audio" ? "audio" : "video";
  console.log(`⬇️ Iniciando download (${tipoSaida}):`, link);

  let arquivoFinal = null;
  let videoInfo = null;
  let processoErro = null;
  const startedAt = Date.now();

  try {
    try {
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
    } catch (infoErro) {
      console.warn(
        "⚠️ Não foi possível obter metadados do vídeo:",
        infoErro.message
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
      path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s"),

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

    const processo = ytDlpWrap.exec(args);

    processo.on("progress", (p) => {
      console.log(`📥 ${p.percent || 0}%`);
    });

    processo.on("ytDlpEvent", (tipo, data) => {
      if (tipo === "after_postprocess" || tipo === "after_move") {
        arquivoFinal = data.trim();
        console.log("📁 Arquivo final:", arquivoFinal);
      }
    });

    processo.on("error", (erro) => {
      processoErro = erro.stderr || erro.message || null;
      console.error("❌ Erro yt-dlp:", processoErro);
    });

    processo.on("close", () => {
      if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
        const arquivos = fs
          .readdirSync(DOWNLOADS_DIR)
          .map((nome) => {
            const fullPath = path.join(DOWNLOADS_DIR, nome);
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs);

        const recentes = arquivos.filter(
          (item) => item.mtimeMs >= startedAt - 60000
        );

        if (recentes.length > 0) {
          arquivoFinal = recentes[0].fullPath;
          console.log("📁 Arquivo final (fallback):", arquivoFinal);
        } else if (arquivos.length > 0) {
          arquivoFinal = arquivos[0].fullPath;
          console.log("📁 Arquivo final (fallback):", arquivoFinal);
        } else {
          console.error("❌ Download finalizou mas arquivo não encontrado");
        }
      }
    });

    // Aguarda finalizar
    await new Promise((resolve) => processo.on("close", resolve));

    if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
      const excedeuLimite =
        processoErro && /max-filesize|file is larger than/i.test(processoErro);
      if (excedeuLimite) {
        return res.status(413).json({
          sucesso: false,
          mensagem: "❌ Arquivo excede o limite de 100MB.",
        });
      }

      return res.status(500).json({
        sucesso: false,
        mensagem: "❌ Download finalizou, mas o arquivo não foi localizado.",
      });
    }

    const tamanhoFinal = fs.statSync(arquivoFinal).size;
    if (tamanhoFinal > MAX_DOWNLOAD_BYTES) {
      fs.unlinkSync(arquivoFinal);
      return res.status(413).json({
        sucesso: false,
        mensagem: "❌ Arquivo excede o limite de 100MB.",
      });
    }

    if (tipoSaida === "video") {
      const temAudio = await hasAudioStream(arquivoFinal);
      if (!temAudio) {
        return res.status(500).json({
          sucesso: false,
          mensagem: "❌ O vídeo baixado não contém faixa de áudio.",
        });
      }
    }

    const nomeArquivo = path.basename(arquivoFinal);

    return res.json({
      sucesso: true,
      mensagem: "✅ Download concluído com sucesso!",
      video_info: videoInfo,
      stream_url: `http://${HOST}:${PORT}/stream/${encodeURIComponent(
        nomeArquivo
      )}`,
    });
  } catch (erro) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Erro ao executar yt-dlp.",
      erro: erro.message,
    });
  }
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

// ==================== START ====================
app.listen(PORT, HOST, () => {
  console.log(`🚀 API rodando em http://${HOST}:${PORT}`);
});
