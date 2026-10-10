#!/usr/bin/env python3
"""
Laya judge for the second brain's no-wake-word listening.

Laya (aac6fef/laya-mlx, MLX, about 843 MB) answers fixed questions about a
short text: pick a label, yes/no, or a score. Same question format as Jev,
but it runs on this Mac, so the transcript never leaves the machine.

POST /system_one  {"state": ..., "questions": {...}}  ->  {"model", "answers", "usage"}
GET  /health                                           ->  200 once the model is loaded

The second-brain server starts this when Laya listening is first used.
It runs with the laya_mlx project's Python:
    ~/code/laya_mlx/.venv/bin/python voice/laya_server.py
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pathlib import Path

import mlx.core as mx
from mlx.utils import tree_flatten

import laya_mlx as laya

PORT = 8181
MODEL_ID = "aac6fef/laya-mlx"
# Decision head trained for listening (voice/train_laya_listen.py). Used when present.
HEAD = Path(__file__).parent / "models" / "laya-listen" / "head.safetensors"

agent = laya.load(MODEL_ID)
if HEAD.exists():
    # Training ran in float32; match each weight to the loaded model's format.
    current = dict(tree_flatten(agent.model.parameters()))
    trained = mx.load(str(HEAD))
    agent.model.load_weights([(k, v.astype(current[k].dtype)) for k, v in trained.items() if k in current], strict=False)
    mx.eval(agent.model.parameters())
    print(f"Loaded the listening head ({len(trained)} weights)", flush=True)
# One forward pass at a time on the GPU.
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/system_one":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            with lock:
                result = agent.system_one(body["state"], body["questions"])
            data = json.dumps(result, ensure_ascii=False).encode()
        except Exception as err:
            print(f"Failed while judging with Laya: {err}", file=sys.stderr)
            self.send_error(500, "Laya could not judge that.")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:
        pass


if __name__ == "__main__":
    print(f"Laya judge ready on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
