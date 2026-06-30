#!/usr/bin/env python
"""Local embedding microservice for the optional dense recall layer.

Keeps a fastembed multilingual MiniLM model warm in memory and serves
embeddings over localhost. Fully local, no external API. The prompt-recall
hook talks to this at query time (~20ms). If the service is down, the hook
degrades to pure BM25 (it never breaks).

Start: `python embed_server.py`, or wire it into your OS autostart.
Health: `curl http://127.0.0.1:11435/health` -> {"ok": true, "model": "...", "dim": 384}
"""
import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Detached starts (pythonw, launchd, systemd) may have no console: log to a
# file next to this script so prints never crash the process.
try:
    _log = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_server.log"),
                "a", buffering=1, encoding="utf-8")
    sys.stdout = _log
    sys.stderr = _log
except Exception:
    pass

from fastembed import TextEmbedding

MODEL_NAME = os.environ.get(
    "AGENT_MEMORY_EMBED_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
HOST = os.environ.get("AGENT_MEMORY_EMBED_HOST", "127.0.0.1")
PORT = int(os.environ.get("AGENT_MEMORY_EMBED_PORT", "11435"))


def _port_busy():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        return s.connect_ex((HOST, PORT)) == 0
    finally:
        s.close()


if _port_busy():
    print(f"[embed] port {PORT} already in use, service is running; exiting.", flush=True)
    raise SystemExit(0)

print(f"[embed] loading {MODEL_NAME} ...", flush=True)
_model = TextEmbedding(model_name=MODEL_NAME)
list(_model.embed(["warmup"]))
DIM = len(list(_model.embed(["x"]))[0])
print(f"[embed] ready dim={DIM} on http://{HOST}:{PORT}", flush=True)


def embed(texts):
    return [v.tolist() for v in _model.embed(texts)]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME, "dim": DIM})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(n) or "{}")
            texts = data.get("texts") or []
            if not isinstance(texts, list) or not texts:
                self._send(400, {"error": "texts[] required"})
                return
            self._send(200, {"embeddings": embed([str(t) for t in texts]), "dim": DIM})
        except Exception as exc:  # boundary: serve a clean error, never crash the server
            self._send(500, {"error": str(exc)})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
