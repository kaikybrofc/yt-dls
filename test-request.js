const API_URL = process.env.API_URL || "http://127.0.0.1:3000";
const YT_LINK = process.env.YT_LINK || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function main() {
  try {
    const healthRes = await fetch(`${API_URL}/`);
    const healthJson = await healthRes.json();
    console.log("Health:", healthJson);

    const downloadRes = await fetch(`${API_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: YT_LINK }),
    });

    const downloadJson = await downloadRes.json();
    console.log("Download:", downloadJson);
  } catch (err) {
    console.error("Erro ao testar API:", err.message);
    process.exitCode = 1;
  }
}

main();
