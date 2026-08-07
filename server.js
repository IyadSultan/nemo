/**
 * Small local server for the OpenAI Realtime voice chatbot.
 *
 * Why this exists:
 * - Your secret OpenAI API key must stay on the server (never in the browser).
 * - The browser sends a WebRTC "offer" (SDP). We forward it to OpenAI with
 *   your key + session settings, then return OpenAI's "answer" to the browser.
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Accept raw SDP text from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MODEL = "gpt-realtime-2.1-mini";
const DEFAULT_VOICE = "marin";

/**
 * Build the Realtime session config OpenAI expects.
 * semantic_vad = smarter turn-taking (when you finish speaking / interrupt).
 */
function buildSessionConfig({ voice = DEFAULT_VOICE, instructions } = {}) {
  return {
    type: "realtime",
    model: MODEL,
    output_modalities: ["audio"],
    instructions:
      instructions ||
      [
        "You are Nemo, a friendly real-time voice assistant.",
        "Speak naturally in short turns, like a phone call.",
        "Prefer clear, warm spoken English unless the user uses another language.",
        "If interrupted, stop and listen, then respond to the new request.",
        "Ask one short clarifying question when something important is unclear.",
      ].join(" "),
    audio: {
      input: {
        // Let OpenAI decide codec for WebRTC; focus on turn-taking + transcripts
        turn_detection: {
          type: "semantic_vad",
          interrupt_response: true,
        },
        transcription: {
          model: "gpt-4o-mini-transcribe",
        },
      },
      output: {
        voice,
      },
    },
  };
}

/**
 * POST /session
 * Body: SDP offer text from the browser
 * Query: ?voice=marin (optional)
 * Returns: SDP answer text from OpenAI
 */
app.post("/session", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Copy .env.example to .env and add your key.",
    });
  }

  const sdp = req.body;
  if (!sdp || typeof sdp !== "string" || !sdp.includes("v=0")) {
    return res.status(400).json({ error: "Expected an SDP offer in the request body." });
  }

  const voice = typeof req.query.voice === "string" ? req.query.voice : DEFAULT_VOICE;

  // Browser can refine instructions later via session.update on the data channel.
  const sessionConfig = buildSessionConfig({ voice });

  try {
    const fd = new FormData();
    fd.set("sdp", sdp);
    fd.set("session", JSON.stringify(sessionConfig));

    // Stable hashed id for OpenAI safety tooling (not a login system)
    const safetyId = crypto
      .createHash("sha256")
      .update(`nemo-local-${apiKey.slice(-8)}`)
      .digest("hex")
      .slice(0, 32);

    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": safetyId,
      },
      body: fd,
    });

    const answerSdp = await upstream.text();

    if (!upstream.ok) {
      console.error("OpenAI /realtime/calls failed:", upstream.status, answerSdp);
      return res.status(upstream.status).type("application/json").send(
        JSON.stringify({
          error: "OpenAI Realtime session failed",
          status: upstream.status,
          details: safeJson(answerSdp),
        })
      );
    }

    res.type("application/sdp").send(answerSdp);
  } catch (err) {
    console.error("Session creation error:", err);
    res.status(500).json({
      error: "Failed to create Realtime session",
      message: err?.message || String(err),
    });
  }
});

/** Health check so you can confirm the server is up */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.listen(PORT, () => {
  console.log(`\nNemo Realtime Voice → http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY is not set. Copy .env.example to .env first.\n");
  } else {
    console.log("API key loaded. Open the URL above and press Start talking.\n");
  }
});

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
