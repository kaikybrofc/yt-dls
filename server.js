const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

// Caminhos
const YTDLP_BINARY_PATH = path.join(__dirname, "bin", "yt-dlp");
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

// Garante pasta de downloads
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Inicializa yt-dlp
const ytDlpWrap = new YTDlpWrap(YTDLP_BINARY_PATH);

/**
 * Verifica se é link do YouTube
 */
function isYoutubeLink(url) {
  const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  return regex.test(url);
}

/**
 * Rota principal
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

  // Nome do arquivo
  const nomeArquivo = `video-${Date.now()}.mp4`;
  const caminhoSaida = path.join(DOWNLOADS_DIR, nomeArquivo);

  console.log("🔗 Download solicitado:", link);

  try {
    const ytDlpEventEmitter = ytDlpWrap.exec([
      link,

      "--cookies",
      COOKIES_PATH,

      "--js-runtimes",
      "node",

      "-f",
      "bv*+ba/b",

      "-o",
      caminhoSaida,

      "--no-warnings",
    ]);

    ytDlpEventEmitter.on("progress", (progress) => {
      console.log(
        `⬇️ ${progress.percent}% | Vel: ${progress.currentSpeed} | ETA: ${progress.eta}`
      );
    });

    ytDlpEventEmitter.on("error", (erro) => {
      console.error("❌ Erro yt-dlp:", erro.stderr || erro.message);
    });

    ytDlpEventEmitter.on("close", (codigo) => {
      if (codigo === 0) {
        console.log("✅ Download concluído:", nomeArquivo);
      } else {
        console.error("❌ yt-dlp finalizou com erro:", codigo);
      }
    });

    // Resposta imediata (assíncrona)
    return res.json({
      sucesso: true,
      mensagem: "📥 Download iniciado com sucesso.",
      arquivo: nomeArquivo,
    });
  } catch (erro) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "❌ Erro ao iniciar o download.",
      erro: erro.message,
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "API yt-dlp online 🚀" });
});

// Porta
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 API rodando em http://localhost:${PORT}`);
});
