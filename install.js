/**
 * Script de instalação do yt-dlp
 *
 * - Baixa automaticamente o binário do yt-dlp
 * - Salva em ./bin/yt-dlp
 * - Funciona em Linux, Windows e macOS
 */

const YTDlpWrap = require("yt-dlp-wrap").default;
const os = require("os");
const fs = require("fs");
const path = require("path");

async function instalarYtDlp() {
  console.log("📥 Iniciando instalação do yt-dlp...");

  // Pasta onde o binário será salvo
  const pastaBin = path.join(__dirname, "bin");
  const caminhoBinario = path.join(pastaBin, "yt-dlp");

  // Cria a pasta ./bin se não existir
  if (!fs.existsSync(pastaBin)) {
    fs.mkdirSync(pastaBin, { recursive: true });
    console.log("📁 Pasta 'bin' criada.");
  }

  // Baixa a versão mais recente do yt-dlp para o sistema operacional atual
  console.log("⬇️ Baixando yt-dlp (versão mais recente)...");
  await YTDlpWrap.downloadFromGithub(
    caminhoBinario, // Caminho onde salvar
    undefined, // Última versão
    os.platform() // Sistema operacional atual
  );

  // Garante permissão de execução no Linux/macOS
  if (os.platform() !== "win32") {
    fs.chmodSync(caminhoBinario, 0o755);
  }

  console.log("✅ yt-dlp instalado com sucesso!");
  console.log(`📍 Caminho do binário: ${caminhoBinario}`);
}

instalarYtDlp().catch((erro) => {
  console.error("❌ Erro ao instalar o yt-dlp:");
  console.error(erro.message);
});
