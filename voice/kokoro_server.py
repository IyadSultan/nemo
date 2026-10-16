#!/usr/bin/env python3
"""
Kokoro voice for the second brain.

The same local voice the claude-voice app uses (Kokoro 82M, voice af_heart
unless the page picks another, speed 1.25). It loads the model once (about
7 seconds), then turns each piece of text into a WAV clip in under a second.
A voice is fetched from Hugging Face the first time it is used. Nothing else
leaves this Mac.

POST /speak  {"text": "...", "voice": "af_heart"}  ->  audio/wav
GET  /health                 ->  200 once the model is loaded

The second-brain server starts this for you. To run it by hand:
    /usr/local/bin/python3.11 voice/kokoro_server.py
"""

from __future__ import annotations

import io
import json
import sys
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from kokoro import KPipeline  # noqa: E402

PORT = 8179
VOICE = "af_heart"
SPEED = 1.25
SAMPLE_RATE = 24000
# The voices the page offers. a = American English, b = British English.
VOICES = {
    "af_heart", "af_bella", "af_nicole", "af_nova", "af_sarah", "af_sky",
    "am_adam", "am_michael", "am_puck",
    "bf_emma", "bf_isabella", "bm_george", "bm_fable",
}

pipes = {"a": KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")}
# Kokoro is not safe to run twice at once. Pieces queue up here.
lock = threading.Lock()


def pipe_for(voice: str) -> KPipeline:
    """British voices read with British phonemes. Both pipelines share one model."""
    lang = voice[0]
    if lang not in pipes:
        pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=pipes["a"].model)
    return pipes[lang]


def synth(text: str, voice: str = VOICE) -> bytes:
    if voice not in VOICES:
        voice = VOICE
    with lock:
        chunks = [r.audio.numpy() for r in pipe_for(voice)(text, voice=voice, speed=SPEED)]
    if not chunks:
        raise RuntimeError("Kokoro produced no audio.")
    out = io.BytesIO()
    sf.write(out, np.concatenate(chunks), SAMPLE_RATE, format="WAV")
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/speak":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                self.send_error(400, "No text to speak.")
                return
            wav = synth(text, str(body.get("voice") or VOICE))
        except Exception as err:
            print(f"Failed while speaking with Kokoro: {err}", file=sys.stderr)
            self.send_error(500, "Kokoro could not speak that.")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, *_args) -> None:
        pass


if __name__ == "__main__":
    print(f"Kokoro voice ready on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
