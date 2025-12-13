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

---

## 🧱 Tecnologias utilizadas

* Node.js
* Express
* yt-dlp
* yt-dlp-wrap

---

## 📁 Estrutura do projeto

```text
yt-dls/
├─ server.js        # API principal
├─ install.js       # Script de instalação do yt-dlp
├─ package.json
├─ cookies.txt      # Cookies do YouTube (formato Netscape)
├─ bin/
│  └─ yt-dlp        # Binário do yt-dlp
└─ downloads/
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

### 🔹 Download de vídeo

```http
POST /download
Content-Type: application/json
```

Body:

```json
{
  "link": "https://youtu.be/VIDEO_ID"
}
```

---

### ✅ Resposta de sucesso

```json
{
  "sucesso": true,
  "mensagem": "📥 Download iniciado com sucesso.",
  "arquivo": "video-1700000000000.mp4"
}
```

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

---

## 📌 Observações importantes

* 🚫 Não copie cookies manualmente do navegador
* ✅ Use sempre cookies no formato Netscape
* ⚠️ Não exponha sua API publicamente sem autenticação
* 💡 Ideal para uso interno ou controlado

---

## 🛣️ Roadmap (futuras melhorias)

* 🔄 Status de download
* 📊 Progresso em tempo real (WebSocket)
* 🧵 Fila de downloads
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
