# yt-dls

API leve para download e conversão de mídia do **YouTube** usando **yt-dlp**, **Node.js** e **Express**.

Projeto focado em:

* Simplicidade de uso via API
* Organização por `request_id`
* Controle de fila e concorrência
* Saída padronizada em MP3/MP4

---

## 🚀 Funcionalidades

* ✅ Download de vídeos do YouTube
* 🔍 Busca simples por título (`GET /search`)
* ⚡ Resolve rápido sem download (`POST /resolve`)
* 🎧 Stream imediato por `track_id` com suporte a `Range` (`GET /stream/:track_id`)
* 🔥 Prefetch de fila com warmup de chunk (`POST /prefetch`)
* 🔐 Suporte a cookies (anti-bot)
* 🧠 Runtime JavaScript exigido pelo YouTube
* 🧵 Fila e limite de concorrência (download, resolve e prefetch)
* 🎛️ Conversão via FFmpeg (MP3/MP4)
* 🌀 Transcode opcional para Opus em tempo real (`?transcode=opus`)
* 📁 Organização automática por `request_id`
* 📦 Stream direto como resposta do download
* 📊 Métricas internas (`GET /metrics`)

---

## ✅ Requisitos

* Node.js instalado
* FFmpeg + FFprobe disponíveis no PATH
* Cookies do YouTube em `cookies.txt` (formato Netscape)

---

## 🧱 Tecnologias utilizadas

* Node.js
* Express
* yt-dlp
* yt-dlp-wrap
* FFmpeg / FFprobe

---

## 📁 Estrutura do projeto

```text
yt-dls/
├─ src/
│  ├─ server.js      # API principal
│  ├─ config.js      # Configurações/limites
│  └─ utils/
│     ├─ media.js    # Conversão/FFmpeg
│     ├─ semaphore.js # Fila/concorrência
│     ├─ stream.js   # Stream de arquivo
│     ├─ remote-stream.js # Proxy stream remoto + warmup
│     ├─ worker-pool.js # Pool de workers persistentes
│     ├─ ttl-cache.js # Cache em memória com TTL
│     ├─ cookie-manager.js # Rotação/refresh de cookies
│     ├─ keyed-limiter.js # Limites por IP/guild
│     ├─ metrics.js # Coleta de métricas
│     └─ validators.js # Validadores
├─ scripts/
│  └─ install.js     # Instalação do yt-dlp
├─ bin/
│  └─ yt-dlp         # Binário do yt-dlp
├─ cookies.txt       # Cookies do YouTube (Netscape)
└─ downloads/
   └─ <request_id>/
      └─ <arquivo>.mp4 | <arquivo>.mp3
```

---

## 📦 Instalação

### 1️⃣ Clonar o repositório

```bash
git clone https://github.com/kaikybrofc/yt-dls.git
cd yt-dls
```

---

### 2️⃣ Instalar dependências

```bash
npm install
```

---

### 3️⃣ Instalar o yt-dlp

```bash
npm run install:yt-dlp
```

Isso baixa automaticamente o binário correto do **yt-dlp** para seu sistema.

---

## 🔐 Configuração de cookies (OBRIGATÓRIO)

O YouTube bloqueia downloads sem autenticação em vários ambientes (especialmente VPS).

### ✅ Passos

1. Faça login no YouTube pelo navegador
2. Instale a extensão **Get cookies.txt (LOCALLY)**
3. Exporte os cookies
4. Salve como `cookies.txt` na raiz do projeto

⚠️ O arquivo precisa estar no formato **Netscape**.

---

## ⚙️ Configuração

As configurações ficam em `src/config.js` (por enquanto não há `.env`).

Valores padrão importantes:

* `HOST`: `127.0.0.1`
* `PORT`: `3013`
* `MAX_DOWNLOAD_BYTES`: `100MB`
* `MAX_CONCURRENT_DOWNLOADS`: `4`
* `MAX_QUEUE_SIZE`: `10`
* `MAX_CONCURRENT_FFMPEG`: via env (default `1`)
* `CONVERT_TIMEOUT_MS`: `300000` (5 min)
* `RESOLVE_CACHE_TTL_MS`: cache curto do resolve (default `120000`)
* `RESOLVE_POOL_SIZE` / `PREFETCH_POOL_SIZE`: workers quentes para baixa latência
* `MAX_ACTIVE_STREAMS_PER_IP` / `MAX_ACTIVE_STREAMS_PER_GUILD`: limite anti-bloqueio
* `YTDLP_MAX_RETRIES` + backoff automático em erro anti-bot
* `ENABLE_OPUS_TRANSCODE=true`: habilita transcode Opus em tempo real

---

## ▶️ Executando a API

```bash
npm start
```

Servidor rodando em:

```
http://127.0.0.1:3013
```

### PM2 (opcional)

```bash
npm run start:pm2
npm run stop:pm2
npm run restart:pm2
npm run delete:pm2
```

---

## 🌐 Endpoints

### 🔹 Health check

```http
GET /
```

Resposta:

```json
{
  "status": "API yt-dlp online 🚀"
}
```

---

### 🔹 Buscar vídeo por nome

```http
GET /search?q=termodebusca
```

Resposta (quando encontra):

```json
{
  "sucesso": true,
  "total": 1,
  "resultado": {
    "id": "VIDEO_ID",
    "title": "Titulo do video",
    "url": "https://www.youtube.com/watch?v=VIDEO_ID"
  }
}
```

> `resultado` contém o primeiro item retornado pelo `yt-dlp` (estrutura completa do `ytsearch1`).

Erros:

```json
{
  "sucesso": false,
  "mensagem": "❌ O parâmetro 'q' é obrigatório."
}
```

---

### 🔹 Resolve rápido (sem download)

```http
POST /resolve
Content-Type: application/json
```

Body:

```json
{
  "link": "https://youtu.be/VIDEO_ID",
  "type": "audio",
  "guild_id": "guild_123"
}
```

Resposta:

```json
{
  "sucesso": true,
  "track_id": "uuid",
  "title": "Titulo",
  "duration": 213,
  "thumbnail": "https://...",
  "stream_url": "http://127.0.0.1:3013/stream/uuid?exp=...&sig=...",
  "expires_at": 1773441310580,
  "cache_hit": false
}
```

---

### 🔹 Prefetch da fila

```http
POST /prefetch
Content-Type: application/json
```

Body:

```json
{
  "track_ids": ["uuid1", "uuid2"]
}
```

Resposta:

```json
{
  "sucesso": true,
  "accepted": [{ "track_id": "uuid1", "status": "pending" }],
  "failed": []
}
```

Status individual:

```http
GET /prefetch/status/:trackId
```

Retorna `pending`, `ready` ou `failed`.

---

### 🔹 Stream imediato por track_id

```http
GET /stream/:track_id?exp=...&sig=...
```

* Suporta `Range` (206 Partial Content)
* Usa chunked transfer quando apropriado
* Se `ENABLE_OPUS_TRANSCODE=true` ou `?transcode=opus`, faz Opus em tempo real (sem `Range`)

---

### 🔹 Download de vídeo ou áudio

```http
POST /download
Content-Type: application/json
```

Body:

```json
{
  "link": "https://youtu.be/VIDEO_ID",
  "type": "video",
  "request_id": "meu_id_123"
}
```

* `type` é opcional: `video` (padrão) ou `audio`
* `request_id` é obrigatório e deve conter apenas letras, números, `_` ou `-`

✅ **Resposta de sucesso**

Retorna o arquivo convertido diretamente (stream do binário).
Headers relevantes:

- `Content-Type`: `video/mp4` ou `audio/mpeg`
- `Content-Disposition`: `attachment; filename="..."`
- `X-Queue-Ahead`: downloads na frente
- `X-Queue-Limit`: limite de concorrência
- `X-Request-Id`: `request_id` usado

Exemplo real (`POST /download`, `type=audio`, capturado em 2026-03-04):

```http
HTTP/1.1 200 OK
Content-Length: 4117035
Content-Type: audio/mpeg
Content-Disposition: attachment; filename="audio_1772665394738_120d879a558da.mp3"
X-Queue-Ahead: 0
X-Queue-Limit: 4
X-Request-Id: readme-ok-1772665376
```

Corpo da resposta:

```text
[binario mp3]
```

---

### ❌ Erros comuns

Campos obrigatórios:

```json
{
  "sucesso": false,
  "mensagem": "❌ O campo 'link' é obrigatório."
}
```

Exemplo real (`POST /download` sem `link`, capturado em 2026-03-04):

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"sucesso":false,"mensagem":"❌ O campo 'link' é obrigatório."}
```

`request_id` inválido:

```json
{
  "sucesso": false,
  "mensagem": "❌ O 'request_id' deve conter apenas letras, números, '_' ou '-'."
}
```

Link inválido:

```json
{
  "sucesso": false,
  "mensagem": "❌ O link informado não é do YouTube."
}
```

Cookies ausentes:

```json
{
  "sucesso": false,
  "mensagem": "❌ Arquivo cookies.txt não encontrado."
}
```

Bloqueio anti-bot do YouTube (HTTP 403):

```json
{
  "sucesso": false,
  "mensagem": "❌ O YouTube solicitou verificação anti-bot para este vídeo.",
  "erro": "Renove o cookies.txt com conta logada e exporte novamente em formato Netscape.",
  "diagnostico": {
    "request_id": "meu_id_123",
    "cookie_path": "/caminho/do/projeto/cookies.txt",
    "cookies_auth_detectados": ["__Secure-3PSID"],
    "dica": "Use a extensão 'Get cookies.txt (LOCALLY)' no navegador já logado no YouTube e substitua o arquivo."
  }
}
```

Fila cheia (HTTP 429):

```json
{
  "sucesso": false,
  "mensagem": "❌ Fila de downloads cheia. Tente novamente mais tarde.",
  "fila": {
    "downloads_a_frente": 4,
    "enfileirados": 10,
    "limite_concorrencia": 4,
    "limite_fila": 10
  }
}
```

Arquivo acima do limite (HTTP 413):

```json
{
  "sucesso": false,
  "mensagem": "❌ Arquivo excede o limite de 100MB."
}
```

Vídeo sem faixa de áudio:

```json
{
  "sucesso": false,
  "mensagem": "❌ O vídeo baixado não contém faixa de áudio."
}
```

Arquivo final não localizado:

```json
{
  "sucesso": false,
  "mensagem": "❌ Download finalizou, mas o arquivo não foi localizado."
}
```

---

### 🔹 Status da fila por request_id

```http
GET /download/queue-status/:requestId
```

Resposta:

```json
{
  "sucesso": true,
  "request_id": "meu_id_123",
  "fila": {
    "status": "queued",
    "downloads_a_frente": 2,
    "posicao_na_fila": 1,
    "enfileirados": 3,
    "limite_concorrencia": 4,
    "limite_fila": 10
  }
}
```

---

### 🔹 Streaming do arquivo baixado

```http
GET /stream/:arquivo
```

* Busca o arquivo diretamente em `downloads/`
* Suporta `Range` para streaming progressivo

---

### 🔹 Streaming por request_id

```http
GET /stream/:requestId/:arquivo
```

* Busca em `downloads/<request_id>/`
* Suporta `Range` para streaming progressivo

---

## 📌 Observações importantes

* 🚫 Não copie cookies manualmente do navegador
* ✅ Use sempre cookies no formato Netscape
* 🔄 Se aparecer erro de anti-bot (HTTP 403), reexporte os cookies com sessão logada no YouTube
* 🎯 Alguns vídeos específicos exigem autenticação mais forte; outros podem baixar normalmente no mesmo servidor
* ⚠️ Não exponha sua API publicamente sem autenticação
* 🧹 O endpoint `/download` remove o arquivo após o envio (cleanup automático)
* 🎛️ A conversão gera MP3 (áudio) ou MP4 H.264/AAC (vídeo, largura máx. 1280)

---

## 🛣️ Roadmap (futuras melhorias)

* 📊 Progresso em tempo real (SSE/WebSocket)
* 🔐 Autenticação por token
* 🐳 Docker

---

## 👤 Autor

**Kaiky Brito**
GitHub: https://github.com/kaikybrofc

---

## 📄 Licença

MIT License

---

🚀 Projeto pronto para evoluir. Contribuições são bem-vindas
