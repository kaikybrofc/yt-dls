# yt-dls

API simples e leve para download de vídeos do **YouTube** utilizando **yt-dlp** com **Node.js** e **Express**.

Projeto focado em:

* Facilidade de uso
* Organização
* Pronto para VPS / produção
* Integração via API REST

---

## 🚀 Funcionalidades

* ✅ Download de vídeos do YouTube
* 🔍 Validação de links (somente YouTube)
* 🔐 Suporte a cookies (anti-bot)
* 🧠 Uso de runtime JavaScript exigido pelo YouTube
* 🌐 API REST simples (`POST /download`)
* 📁 Organização automática de arquivos
* 🧵 Fila e limite de concorrência para downloads
* 🎛️ Conversão via FFmpeg (MP3/MP4)

---

## 🧱 Tecnologias utilizadas

* Node.js
* Express
* yt-dlp
* yt-dlp-wrap
* FFmpeg

---

## 📁 Estrutura do projeto

```text
yt-dls/
├─ src/
│  └─ server.js     # API principal
├─ scripts/
│  ├─ install.js    # Script de instalação do yt-dlp
│  └─ test-request.js # Teste da API
├─ package.json
├─ cookies.txt      # Cookies do YouTube (formato Netscape)
├─ bin/
│  └─ yt-dlp        # Binário do yt-dlp
└─ downloads/
   └─ <request_id>/
      └─ video-xxxx.mp4
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

Isso irá baixar automaticamente o binário correto do **yt-dlp** para seu sistema.

---

## 🔐 Configuração de cookies (OBRIGATÓRIO)

O YouTube bloqueia downloads sem autenticação em VPS.

### ✅ Forma correta

1. Faça login no YouTube pelo navegador
2. Instale a extensão **Get cookies.txt (LOCALLY)**
3. Exporte os cookies
4. Salve o arquivo como `cookies.txt` na raiz do projeto

⚠️ O arquivo **precisa** estar no formato **Netscape**.

---

## ▶️ Executando a API

```bash
npm start
```

Servidor rodando em:

```
http://localhost:3000
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

Resposta (quando não encontra):

```json
{
  "sucesso": true,
  "total": 0,
  "resultado": null
}
```

Erros:

```json
{
  "sucesso": false,
  "mensagem": "❌ O parâmetro 'q' é obrigatório."
}
```

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

---

### ✅ Resposta de sucesso

Retorna o arquivo convertido diretamente (stream do binário).
Headers relevantes:

- `Content-Type`: `video/mp4` ou `audio/mpeg`
- `Content-Disposition`: `attachment; filename="..."`
- `X-Queue-Ahead`: quantos downloads estavam na frente
- `X-Queue-Limit`: limite de concorrência
- `X-Request-Id`: request_id usado

```json
<binary>
```

Observações:

* `type` é opcional: `video` (padrão) ou `audio`
* Quando `type = audio`, o arquivo final é `.mp3`
* `request_id` é obrigatório e deve conter apenas letras, números, `_` ou `-`
* O arquivo é removido após o envio (cleanup automático)

---

### ❌ Erros comuns

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
    "limite_concorrencia": 2,
    "limite_fila": 10
  }
}
```

---

### 🔹 Streaming do arquivo baixado

```http
GET /stream/:arquivo
```

Exemplo:

```http
GET /stream/Meu%20Video.mp4
Range: bytes=0-
```

Notas:

* Suporta `Range` para streaming progressivo
* O arquivo deve existir na pasta `downloads/`

---

## 📌 Observações importantes

* 🚫 Não copie cookies manualmente do navegador
* ✅ Use sempre cookies no formato Netscape
* ⚠️ Não exponha sua API publicamente sem autenticação
* 💡 Ideal para uso interno ou controlado
* ⚙️ Configure o limite de conversão com `MAX_CONCURRENT_FFMPEG`

---

## 🛣️ Roadmap (futuras melhorias)

* 🔄 Status de download
* 📊 Progresso em tempo real (WebSocket)
* 🔐 Autenticação por token
* 🐳 Docker

---

## 👤 Autor

**Kaiky Brito**
🔗 GitHub: [https://github.com/kaikybrofc](https://github.com/kaikybrofc)

---

## 📄 Licença

MIT License

---

🚀 Projeto pronto para evoluir. Contribuições são bem-vindas
