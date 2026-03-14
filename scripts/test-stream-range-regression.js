const DEFAULT_BASE_URL = "http://127.0.0.1:3013";
const DEFAULT_INTERRUPT_AT_BYTES = 256 * 1024;
const DEFAULT_RESUME_READ_BYTES = 128 * 1024;
const DEFAULT_TYPE = "audio";

function getArg(flagName, fallback = "") {
  const index = process.argv.indexOf(flagName);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function readAtLeast(response, targetBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Resposta sem body legível em stream.");
  }

  const reader = response.body.getReader();
  let received = 0;
  let done = false;

  try {
    while (!done && received < targetBytes) {
      const chunk = await reader.read();
      done = Boolean(chunk.done);
      if (chunk.value) {
        received += chunk.value.byteLength;
      }
    }
  } finally {
    try {
      await reader.cancel("regression test interruption");
    } catch (_error) {}
  }

  return received;
}

async function main() {
  const baseUrl = String(getArg("--base", DEFAULT_BASE_URL)).replace(/\/$/, "");
  const link = String(getArg("--link", "")).trim();
  const guildId = String(getArg("--guild", "regression-guild")).trim();
  const type = String(getArg("--type", DEFAULT_TYPE)).trim() || DEFAULT_TYPE;
  const interruptAtBytes = asPositiveInt(
    getArg("--interrupt-bytes", DEFAULT_INTERRUPT_AT_BYTES),
    DEFAULT_INTERRUPT_AT_BYTES,
  );
  const resumeReadBytes = asPositiveInt(
    getArg("--resume-read-bytes", DEFAULT_RESUME_READ_BYTES),
    DEFAULT_RESUME_READ_BYTES,
  );

  if (!link) {
    console.error(
      "Uso: node scripts/test-stream-range-regression.js --link <youtube_url> [--base http://127.0.0.1:3013]",
    );
    process.exit(1);
  }

  const resolveResponse = await fetch(`${baseUrl}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guild-id": guildId,
    },
    body: JSON.stringify({
      link,
      type,
      guild_id: guildId,
    }),
  });

  const resolveText = await resolveResponse.text();
  if (!resolveResponse.ok) {
    throw new Error(
      `Resolve falhou (${resolveResponse.status}): ${resolveText.slice(0, 300)}`,
    );
  }

  let resolvedPayload = null;
  try {
    resolvedPayload = JSON.parse(resolveText);
  } catch (error) {
    throw new Error(`Resposta de resolve não é JSON válido: ${error.message}`);
  }

  const streamUrl = String(resolvedPayload?.stream_url || "").trim();
  if (!streamUrl) {
    throw new Error("Resolve não retornou stream_url.");
  }

  const firstStream = await fetch(streamUrl, {
    headers: {
      "x-guild-id": guildId,
    },
  });

  if (![200, 206].includes(firstStream.status)) {
    const firstErrorBody = await firstStream.text();
    throw new Error(
      `Primeiro stream retornou ${firstStream.status}: ${firstErrorBody.slice(0, 300)}`,
    );
  }

  const consumedBytes = await readAtLeast(firstStream, interruptAtBytes);
  if (consumedBytes <= 0) {
    throw new Error("Não foi possível consumir bytes no primeiro stream.");
  }

  const resumeHeader = `bytes=${consumedBytes}-`;
  const resumedStream = await fetch(streamUrl, {
    headers: {
      Range: resumeHeader,
      "x-guild-id": guildId,
    },
  });

  if (resumedStream.status === 404) {
    const body = await resumedStream.text();
    throw new Error(`Regressão detectada: resume com Range voltou 404. Body: ${body}`);
  }

  if (![200, 206].includes(resumedStream.status)) {
    const body = await resumedStream.text();
    throw new Error(
      `Resume com Range falhou (${resumedStream.status}): ${body.slice(0, 300)}`,
    );
  }

  const resumedBytes = await readAtLeast(resumedStream, resumeReadBytes);
  if (resumedBytes <= 0) {
    throw new Error("Resume com Range não retornou dados.");
  }

  console.log("✅ Regressão de Range passou.");
  console.log(`track_id: ${resolvedPayload.track_id}`);
  console.log(`bytes_lidos_primeiro_stream: ${consumedBytes}`);
  console.log(`range_resume_enviado: ${resumeHeader}`);
  console.log(`status_resume: ${resumedStream.status}`);
  console.log(`bytes_lidos_resume: ${resumedBytes}`);
}

main().catch((error) => {
  console.error(`❌ Falha no teste de regressão de stream/range: ${error.message}`);
  process.exit(1);
});
