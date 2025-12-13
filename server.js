const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const PORT = 3000;

const YTDLP_BINARY_PATH = path.join(__dirname, "bin", "yt-dlp");
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

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

// ==================== ROTAS ====================

// Health check
app.get("/", (req, res) => {
  res.json({ status: "API yt-dlp online 🚀" });
});

/**
 * Inicia download
 */
app.post("/download", async (req, res) => {
  const { link } = req.body;

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

  console.log("⬇️ Iniciando download:", link);

  let arquivoFinal = null;

  try {
    const processo = ytDlpWrap.exec([
      link,

      // Cookies e runtime JS
      "--cookies",
      COOKIES_PATH,
      "--js-runtimes",
      "node",

      // Melhor vídeo + áudio
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",

      // Template de saída (NÃO adivinhamos nome)
      "-o",
      path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s"),

      // Retorna o caminho real do arquivo final
      "--print",
      "after_postprocess:%(filepath)s",
      "--print",
      "after_move:%(filepath)s",

      "--no-warnings",
    ]);

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
      console.error("❌ Erro yt-dlp:", erro.stderr || erro.message);
    });

    processo.on("close", () => {
      if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
        console.error("❌ Download finalizou mas arquivo não encontrado");
      }
    });

    // Aguarda finalizar
    await new Promise((resolve) => processo.on("close", resolve));

    if (!arquivoFinal || !fs.existsSync(arquivoFinal)) {
      return res.status(500).json({
        sucesso: false,
        mensagem: "❌ Download finalizou, mas o arquivo não foi localizado.",
      });
    }

    const nomeArquivo = path.basename(arquivoFinal);

    return res.json({
      sucesso: true,
      mensagem: "✅ Download concluído com sucesso!",
      stream_url: `https://omnizap.shop/stream/${encodeURIComponent(
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
app.listen(PORT, () => {
  console.log(`🚀 API rodando em http://localhost:${PORT}`);
});
