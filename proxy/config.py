"""Configuration for the ambient recall proxy."""

import os
from pathlib import Path


# Upstream API
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
UPSTREAM_URL = os.environ.get("AMBIENT_UPSTREAM", "https://api.anthropic.com")

# Database
DB_PATH = os.environ.get("AMBIENT_DB_PATH",
    str(Path.home() / "Projects/PRJ-johnny5-memory/dist/memory.db"))

# Ollama
OLLAMA_URL = os.environ.get("AMBIENT_OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("AMBIENT_EMBED_MODEL", "nomic-embed-text")
EMBED_DIM = int(os.environ.get("AMBIENT_EMBED_DIM", "768"))

# Retrieval
TAU_INJECT = float(os.environ.get("AMBIENT_TAU_INJECT", "0.55"))
TAU_SIGNAL = float(os.environ.get("AMBIENT_TAU_SIGNAL", "0.65"))
TOKEN_BUDGET = int(os.environ.get("AMBIENT_TOKEN_BUDGET", "1500"))
KNN_K = int(os.environ.get("AMBIENT_KNN_K", "20"))

# Dedup
WINDOW_TURNS = int(os.environ.get("AMBIENT_WINDOW_TURNS", "3"))
DEDUP_TURNS = int(os.environ.get("AMBIENT_DEDUP_TURNS", "3"))

# Logging
LOG_PATH = os.environ.get("AMBIENT_LOG_PATH",
    str(Path.home() / ".ambient-recall/log.jsonl"))

# Server
PROXY_PORT = int(os.environ.get("AMBIENT_PROXY_PORT", "8780"))
