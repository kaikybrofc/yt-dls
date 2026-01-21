const fs = require("fs");
const path = require("path");

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

module.exports = { streamFileResponse };
