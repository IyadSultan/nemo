/**
 * Live voice lines the browser opens itself: an OpenAI Realtime session (/session)
 * and a short-lived Gemini Live token (/gemini-session). Keys never leave this server.
 */

import { DEFAULT_VOICE, VOICE_MODEL } from "./config.js";
import { clientError, redactSecrets } from "./models.js";
import { getAnyModel } from "./pricing.js";
import { voiceInstructions } from "./prompt.js";
import crypto from "node:crypto";

/**
 * Live voice session. Same model as Nemo: gpt-realtime-2.1-mini.
 * It receives microphone audio, so it can hear the user.
 */
// Gemini has its own voices. Pick the closest one to the voice chosen on the page.
export const GEMINI_VOICES = { marin: "Aoede", cedar: "Charon", alloy: "Puck", ash: "Orus", coral: "Kore", sage: "Leda" };

export function registerLive(app) {
  /**
   * Gemini Live: mint a short-lived Google token so the browser can open the
   * voice line itself. The GEMINI_API_KEY never leaves this server.
   * The token is locked to one session, this model, and this setup.
   */
  app.post("/gemini-session", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY. Add it to the .env file." });
    const model = getAnyModel(req.query.model);
    if (!model?.gemini) return res.status(400).json({ error: "That is not a Gemini Live model." });

    const setup = {
      model: `models/${model.id}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICES[req.query.voice] || "Aoede" } } },
      },
      // Gemini answers every turn; the Hey rule would only make it go quiet.
      systemInstruction: { parts: [{ text: voiceInstructions().replace(/^Stay silent unless.*\n/m, "") }] },
      tools: [{
        functionDeclarations: [
          {
            name: "here_and_now",
            description: "Read this Mac's clock. Returns the current time and place in words the voice can say.",
          },
          {
            name: "search_notes",
            description: "Search the user's second-brain notes. When he asks to find a file, this also reads wiki/index.md and wiki/log.md and returns the matching lines.",
            parameters: {
              type: "OBJECT",
              properties: { query: { type: "STRING", description: "What to look up in the notes, in a few words." } },
              required: ["query"],
            },
          },
        ],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    const now = Date.now();
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(now + 30 * 60_000).toISOString(),
          newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const geminiError = data.error?.message || "Gemini refused the token.";
        console.error("Gemini refused the token:", redactSecrets(geminiError));
        return res.status(502).json({ error: clientError(geminiError, "Gemini refused the token.") });
      }
      res.json({ token: data.name, setup });
    } catch (err) {
      console.error("Failed while minting a Gemini token:", err?.message || err);
      res.status(502).json({ error: "Could not reach Gemini." });
    }
  });

  app.post("/session", async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
      });
    }

    const sdp = req.body;
    if (!sdp || typeof sdp !== "string" || !sdp.includes("v=0")) {
      return res.status(400).json({ error: "Expected an SDP offer in the request body." });
    }

    const voice = typeof req.query.voice === "string" ? req.query.voice : DEFAULT_VOICE;
    const speakOnly = req.query.speak === "1";
    const chosen = getAnyModel(req.query.model) || getAnyModel(VOICE_MODEL);
    let reasoning = typeof req.query.reasoning === "string" ? req.query.reasoning : chosen.reasoning[0];
    if (!chosen.reasoning.includes(reasoning)) reasoning = chosen.reasoning[0];

    // A GPT-6 model never sits on the live voice line.
    // Listening is the local model on this Mac.
    // This session is only the voice-control model reading the answer aloud.
    const ears = speakOnly || !chosen.hears ? getAnyModel(VOICE_MODEL) : chosen;

    const sessionConfig = {
      type: "realtime",
      model: ears.id,
      output_modalities: ["audio"],
      instructions: speakOnly || !chosen.hears
        ? "Speak only the script you are given. Do not add anything. Do not answer on your own."
        : voiceInstructions(),
      tools: speakOnly ? undefined : [
        {
          type: "function",
          name: "here_and_now",
          description: "Read this Mac's clock. Returns the current time and place in words the voice can say.",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "search_notes",
          description: "Search the user's second-brain wiki. When he asks to find a file, this also reads wiki/index.md and wiki/log.md (logs dot md) and returns the matching lines.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "What to look up in the notes, in a few words.",
              },
            },
            required: ["query"],
          },
        },
      ],
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            // Low eagerness so the speaker's own voice does not cut the reply off.
            eagerness: "low",
            interrupt_response: !speakOnly,
            // The page decides when to answer. It only does that after "Hey".
            create_response: false,
          },
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
        },
        output: { voice },
      },
    };
    if (speakOnly) delete sessionConfig.tools;
    if (chosen.hears && !speakOnly && reasoning !== "none") sessionConfig.reasoning = { effort: reasoning };

    try {
      const fd = new FormData();
      fd.set("sdp", sdp);
      fd.set("session", JSON.stringify(sessionConfig));
      const safetyId = crypto
        .createHash("sha256")
        .update(`brain-voice-${apiKey.slice(-8)}`)
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
        // Logged here, not sent to the browser. The voice call to OpenAI still happens.
        console.error("OpenAI voice session failed:", upstream.status, redactSecrets(answerSdp));
        return res.status(upstream.status).json({
          error: "OpenAI voice session failed",
          status: upstream.status,
        });
      }
      res.type("application/sdp").send(answerSdp);
    } catch (err) {
      const reason = err?.cause?.message || err?.message || String(err);
      console.error("Failed while starting the voice session:", redactSecrets(reason));
      res.status(500).json({ error: "Could not reach OpenAI." });
    }
  });
}
