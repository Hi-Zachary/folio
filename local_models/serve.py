"""Local embedding + rerank service (CPU) for Folio.

Exposes an OpenAI-compatible embedding endpoint and a Cohere/Jina-style rerank
endpoint so the Node app can use local models with no code branching.

Run:
    HF_HOME=/root/autodl-tmp/hf-cache \
    python3 local_models/serve.py --port 8080

Endpoints:
    POST /v1/embeddings  {"model": "...", "input": "text" | ["text", ...]}
                         -> {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [...]}], "model": "..."}
    POST /v1/rerank      {"model": "...", "query": "...", "documents": ["...", ...], "top_n": 5}
                         -> {"results": [{"index": 2, "relevance_score": 0.91}, ...]}
    GET  /v1/models
    GET  /health
"""

import argparse
import math
import os
import time

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder, SentenceTransformer

EMBEDDING_MODEL = os.environ.get("LOCAL_EMBEDDING_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.environ.get("LOCAL_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
THREADS = int(os.environ.get("LOCAL_MODEL_THREADS", str(os.cpu_count() or 8)))
EMBED_BATCH = int(os.environ.get("LOCAL_EMBED_BATCH", "16"))

torch.set_num_threads(THREADS)
app = FastAPI(title="folio-local-models")

embedder: SentenceTransformer | None = None
reranker: CrossEncoder | None = None


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str]


class RerankRequest(BaseModel):
    model: str | None = None
    query: str
    documents: list[str]
    top_n: int | None = None


@app.get("/health")
def health():
    return {
        "ok": embedder is not None and reranker is not None,
        "embedding_model": EMBEDDING_MODEL,
        "rerank_model": RERANK_MODEL,
        "threads": THREADS,
    }


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [
            {"id": EMBEDDING_MODEL, "object": "model", "owned_by": "local"},
            {"id": RERANK_MODEL, "object": "model", "owned_by": "local"},
        ],
    }


@app.post("/v1/embeddings")
def embeddings(body: EmbeddingRequest):
    texts = [body.input] if isinstance(body.input, str) else list(body.input)
    vectors = embedder.encode(
        texts,
        batch_size=EMBED_BATCH,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return {
        "object": "list",
        "model": body.model or EMBEDDING_MODEL,
        "data": [
            {"object": "embedding", "index": index, "embedding": vector.tolist()}
            for index, vector in enumerate(vectors)
        ],
    }


@app.post("/v1/rerank")
def rerank(body: RerankRequest):
    documents = list(body.documents)
    if not documents:
        return {"results": []}
    pairs = [[body.query, document] for document in documents]
    logits = reranker.predict(pairs, batch_size=EMBED_BATCH, show_progress_bar=False)
    scored = []
    for index, value in enumerate(logits):
        try:
            score = 1.0 / (1.0 + math.exp(-float(value)))
        except OverflowError:
            score = 0.0 if float(value) < 0 else 1.0
        scored.append({"index": index, "relevance_score": score})
    scored.sort(key=lambda item: item["relevance_score"], reverse=True)
    if body.top_n:
        scored = scored[: body.top_n]
    return {"model": body.model or RERANK_MODEL, "results": scored}


def main():
    global embedder, reranker
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    started = time.time()
    print(f"[local-models] loading {EMBEDDING_MODEL} ...", flush=True)
    embedder = SentenceTransformer(EMBEDDING_MODEL)
    print(f"[local-models] loading {RERANK_MODEL} ...", flush=True)
    reranker = CrossEncoder(RERANK_MODEL)
    print(f"[local-models] ready in {time.time() - started:.1f}s, threads={THREADS}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
