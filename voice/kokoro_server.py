#!/usr/bin/env python3
"""
Kokoro voice for the second brain.

The same local voice the claude-voice app uses (Kokoro 82M, voice af_heart,
speed 1.25). It loads the model once (about 7 seconds), then turns each
piece of text into a WAV clip in under a second. Nothing leaves this Mac.

POST /speak  {"text": "..."}  ->  audio/wav
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

pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
# Kokoro is not safe to run twice at once. Pieces queue up here.
lock = threading.Lock()


def synth(text: str) -> bytes:
    with lock:
        chunks = [r.audio.numpy() for r in pipe(text, voice=VOICE, speed=SPEED)]
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
            text = (json.loads(self.rfile.read(length) or b"{}").get("text") or "").strip()
            if not text:
                self.send_error(400, "No text to speak.")
                return
            wav = synth(text)
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
