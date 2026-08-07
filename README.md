# Nemo — OpenAI Realtime Voice Chatbot

A simple **speech-to-speech** chatbot for your Mac browser.

You talk into the microphone → OpenAI’s Realtime model listens and answers with voice → you can interrupt naturally.

Built with:

- **OpenAI Realtime API** (`gpt-realtime-2.1-mini`) over **WebRTC**
- A tiny **Node.js** server that keeps your API key secret
- A clean browser UI with live transcripts

---

## What you need

1. A Mac (your M5 is fine — the heavy AI runs in OpenAI’s cloud)
2. [Node.js 18+](https://nodejs.org/) installed
3. An [OpenAI API key](https://platform.openai.com/api-keys) with access to the Realtime API
4. Headphones (recommended — reduces echo)

---

## Setup (first time)

In Terminal:

```bash
cd /Users/USER/code/nemo
cp .env.example .env
```

Open `.env` and paste your key:

```bash
OPENAI_API_KEY=sk-your-real-key-here
```

Install packages and start the server:

```bash
npm install
npm start
```

Open in your browser:

**http://localhost:3000**

Click **Start talking**, allow the microphone, and speak.

---

## How to use it

| Control | What it does |
|---|---|
| **Start talking** | Connects to OpenAI and opens the mic |
| **End call** | Stops the session |
| **Voice** | Pick the assistant voice (before starting) |
| **Mute mic** | Temporarily stop sending your audio |
| **Transcript** | Shows what you and Nemo said |

Tips for natural conversation:

- Speak in short turns, like a phone call
- Interrupt anytime — the model uses semantic turn detection
- Prefer a headset for clearer audio

---

## Project layout

```text
nemo/
  server.js          # Keeps your API key safe; creates Realtime sessions
  public/
    index.html       # Page structure
    styles.css       # Look and feel
    app.js           # Mic + WebRTC + transcripts
  .env.example       # Template for your API key
  package.json
```

### How the pieces fit together

```text
Browser (mic + speakers)
    │  WebRTC audio + events
    ▼
Your local server (server.js)  ← only place that sees OPENAI_API_KEY
    │
    ▼
OpenAI Realtime API (cloud)
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| “Missing OPENAI_API_KEY” | Create `.env` from `.env.example` and restart `npm start` |
| Mic permission denied | Click Allow in the browser address bar; use `localhost` (not a random IP) |
| No sound from assistant | Check system output device; click the page once; try headphones |
| Session / 401 / 403 errors | Confirm the key is valid and your OpenAI project can use Realtime |
| High latency | Prefer wired headphones and a stable network |

Check the server is healthy:

```bash
curl http://localhost:3000/health
```

---

## Cost note

Realtime voice uses OpenAI billable usage (audio in/out). Keep an eye on [usage](https://platform.openai.com/usage) while testing.

---

## Next ideas

- Add tools (weather, calendar, your own APIs)
- Persist chat history
- Deploy the Node server behind HTTPS for remote access
