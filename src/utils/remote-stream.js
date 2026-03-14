const http = require("http");
const https = require("https");

const SHARED_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});

const SHARED_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});

function getHttpClient(urlObject) {
  return urlObject.protocol === "https:" ? https : http;
}

function getKeepAliveAgent(urlObject) {
  return urlObject.protocol === "https:" ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT;
}

function parseExpireFromStreamUrl(streamUrl) {
  try {
    const parsed = new URL(streamUrl);
    const expire = parsed.searchParams.get("expire");
    if (!expire) return null;

    const asNumber = Number(expire);
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null;

    if (String(expire).length <= 10) {
      return asNumber * 1000;
    }

    return asNumber;
  } catch (_error) {
    return null;
  }
}

function createRequest(urlString, options = {}) {
  const urlObject = new URL(urlString);
  const client = getHttpClient(urlObject);
  const defaultAgent = getKeepAliveAgent(urlObject);

  const {
    method = "GET",
    headers = {},
    timeoutMs = 20000,
    rejectUnauthorized = true,
    agent = defaultAgent,
  } = options;

  return new Promise((resolve, reject) => {
    const req = client.request(
      urlObject,
      {
        method,
        headers,
        rejectUnauthorized,
        agent,
      },
      (res) => {
        resolve({ req, res, urlObject });
      },
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Upstream timeout (${timeoutMs}ms)`));
    });

    req.end();
  });
}

async function requestWithRedirect(
  urlString,
  options = {},
  redirectCount = 0,
  maxRedirects = 4,
) {
  const response = await createRequest(urlString, options);
  const location = response.res.headers.location;

  if (
    location &&
    [301, 302, 303, 307, 308].includes(response.res.statusCode || 0)
  ) {
    if (redirectCount >= maxRedirects) {
      throw new Error("Numero maximo de redirecionamentos excedido");
    }

    response.res.resume();
    const nextUrl = new URL(location, response.urlObject).toString();
    return requestWithRedirect(nextUrl, options, redirectCount + 1, maxRedirects);
  }

  return {
    ...response,
    finalUrl: response.urlObject.toString(),
  };
}

function copyUpstreamHeaders(
  upstreamHeaders,
  res,
  { keepContentLength = true, keepContentRange = true } = {},
) {
  const passList = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "last-modified",
    "etag",
  ];

  for (const header of passList) {
    if (!keepContentLength && header === "content-length") {
      continue;
    }
    if (!keepContentRange && header === "content-range") {
      continue;
    }

    const value = upstreamHeaders[header];
    if (value !== undefined) {
      res.setHeader(header, value);
    }
  }
}

function parseTotalBytesFromContentRange(contentRangeRaw) {
  const contentRange = String(contentRangeRaw || "").trim();
  if (!contentRange) return null;

  const match = contentRange.match(/^bytes\s+\d+-\d+\/(\d+|\*)$/i);
  if (!match || !match[1] || match[1] === "*") {
    return null;
  }

  const total = Number(match[1]);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return total;
}

async function fetchWarmupChunk(streamUrl, options = {}) {
  const {
    bytes = 65536,
    timeoutMs = 20000,
    headers = {},
  } = options;

  const rangeEnd = Math.max(1, Number(bytes) || 65536) - 1;

  const { res } = await requestWithRedirect(streamUrl, {
    method: "GET",
    timeoutMs,
    headers: {
      ...headers,
      Range: `bytes=0-${rangeEnd}`,
    },
  });

  if (![200, 206].includes(res.statusCode || 0)) {
    const status = res.statusCode || "desconhecido";
    res.resume();
    throw new Error(`Falha no warmup chunk, status=${status}`);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    const finalize = () => {
      if (finished) return;
      finished = true;
      const buffer = Buffer.concat(chunks, total);
      resolve({
        buffer,
        bytes: buffer.length,
        contentType: res.headers["content-type"] || null,
        statusCode: res.statusCode || 0,
      });
    };

    res.on("data", (chunk) => {
      if (total >= bytes) return;

      const remaining = bytes - total;
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(piece);
      total += piece.length;

      if (total >= bytes) {
        res.destroy();
      }
    });

    res.on("end", finalize);
    res.on("close", finalize);
    res.on("error", (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

function proxyRemoteStream({
  req,
  res,
  streamUrl,
  timeoutMs = 20000,
  headers = {},
  warmChunk = null,
  onFirstByte = null,
}) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    let firstByteSent = false;
    let upstreamReq = null;
    let upstreamRes = null;

    const done = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const markFirstByte = () => {
      if (firstByteSent) return;
      firstByteSent = true;
      if (typeof onFirstByte === "function") {
        onFirstByte();
      }
    };

    const clientClosed = () => {
      if (upstreamRes && !upstreamRes.destroyed) {
        upstreamRes.destroy();
      }
      if (upstreamReq && !upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
      done();
    };

    req.on("aborted", clientClosed);
    res.on("close", clientClosed);

    const requestHeaders = {
      ...headers,
      "User-Agent": headers["User-Agent"] || "yt-dls/1.0",
      Accept: headers.Accept || "*/*",
    };

    let useWarmChunk = false;
    let warmBytes = 0;
    if (!req.headers.range && warmChunk && Buffer.isBuffer(warmChunk.buffer)) {
      useWarmChunk = true;
      warmBytes = warmChunk.buffer.length;
      requestHeaders.Range = `bytes=${warmBytes}-`;
    } else if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    let upstream;
    try {
      upstream = await requestWithRedirect(streamUrl, {
        method: "GET",
        timeoutMs,
        headers: requestHeaders,
      });
      upstreamReq = upstream.req;
    } catch (error) {
      return done(error);
    }

    upstreamRes = upstream.res;

    const statusCode = upstreamRes.statusCode || 502;
    if (statusCode >= 400) {
      upstreamRes.resume();
      const upstreamError = new Error(`Upstream retornou status ${statusCode}`);
      upstreamError.code = "UPSTREAM_HTTP_ERROR";
      upstreamError.upstreamStatusCode = statusCode;
      return done(upstreamError);
    }

    const upstreamTotalBytes = parseTotalBytesFromContentRange(
      upstreamRes.headers["content-range"],
    );
    const shouldInjectWarmChunk = useWarmChunk && statusCode === 206;

    if (shouldInjectWarmChunk) {
      res.statusCode = 200;
      res.setHeader("accept-ranges", "bytes");
      res.setHeader(
        "content-type",
        warmChunk.contentType || upstreamRes.headers["content-type"] || "audio/webm",
      );
      copyUpstreamHeaders(upstreamRes.headers, res, {
        keepContentLength: false,
        keepContentRange: false,
      });
      if (Number.isFinite(upstreamTotalBytes)) {
        res.setHeader("content-length", String(upstreamTotalBytes));
      }
      res.write(warmChunk.buffer);
      markFirstByte();
    } else {
      res.statusCode = statusCode;
      copyUpstreamHeaders(upstreamRes.headers, res, {
        keepContentLength: true,
      });
      if (!res.hasHeader("accept-ranges")) {
        res.setHeader("accept-ranges", "bytes");
      }
    }

    upstreamRes.on("data", () => {
      markFirstByte();
    });

    upstreamRes.on("error", (error) => {
      if (!res.headersSent) {
        res.status(502).json({ sucesso: false, mensagem: "❌ Falha no stream." });
      } else {
        res.end();
      }
      done(error);
    });

    upstreamRes.on("end", () => {
      if (!res.writableEnded) {
        res.end();
      }
      done();
    });

    upstreamRes.pipe(res, { end: false });
  });
}

module.exports = {
  parseExpireFromStreamUrl,
  requestWithRedirect,
  fetchWarmupChunk,
  proxyRemoteStream,
};
