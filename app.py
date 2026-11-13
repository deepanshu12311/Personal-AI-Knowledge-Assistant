from __future__ import annotations

import hashlib
import os
import re
import secrets
from pathlib import Path
from typing import Any

import chromadb
import httpx
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from docx import Document
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader

ROOT = Path(__file__).parent
DATA = Path(os.getenv("KNOWLEDGE_DATA_DIR", ROOT / "data")).resolve()
DATA.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = 100 * 1024 * 1024
ALLOWED = {".txt", ".md", ".pdf", ".docx"}
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")

embedding = SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
client = chromadb.PersistentClient(path=str(DATA / "vectors"))
collection = client.get_or_create_collection(
    "personal_knowledge", embedding_function=embedding, metadata={"hnsw:space": "cosine"}
)
app = FastAPI(title="Morrow · Personal Knowledge")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


def split_text(text: str, size: int = 850, overlap: int = 140) -> list[str]:
    words = re.split(r"\s+", text.strip())
    chunks: list[str] = []
    start = 0
    while start < len(words):
        chunk = " ".join(words[start : start + size]).strip()
        if len(chunk) > 40:
            chunks.append(chunk)
        start += size - overlap
    return chunks


def extract_text(filename: str, content: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext in {".txt", ".md"}:
        return content.decode("utf-8", errors="replace")
    if ext == ".pdf":
        import io
        return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(content)).pages)
    if ext == ".docx":
        import io
        document = Document(io.BytesIO(content))
        return "\n".join(p.text for p in document.paragraphs)
    raise HTTPException(415, "Use a PDF, DOCX, Markdown, or text file.")


def source_label(meta: dict[str, Any]) -> dict[str, str]:
    return {"id": str(meta.get("source_id", "")), "name": str(meta.get("filename", "Untitled"))}


@app.get("/")
async def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/sources")
async def sources():
    data = collection.get(include=["metadatas"])
    unique: dict[str, dict[str, str]] = {}
    for meta in data.get("metadatas") or []:
        src = source_label(meta or {})
        unique[src["id"]] = src
    return {"sources": list(unique.values())}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    filename = Path(file.filename or "document").name
    if Path(filename).suffix.lower() not in ALLOWED:
        raise HTTPException(415, "Use a PDF, DOCX, Markdown, or text file.")
    content = await file.read(MAX_UPLOAD + 1)
    if not content or len(content) > MAX_UPLOAD:
        raise HTTPException(413, "Files must be under 100 MB and contain data.")
    text = extract_text(filename, content)
    chunks = split_text(text)
    if not chunks:
        raise HTTPException(422, "No readable text was found in that file.")
    source_id = secrets.token_urlsafe(12)
    digest = hashlib.sha256(content).hexdigest()
    ids = [f"{source_id}_{i}" for i in range(len(chunks))]
    collection.add(ids=ids, documents=chunks,
                   metadatas=[{"source_id": source_id, "filename": filename, "sha256": digest,
                               "chunk": i} for i in range(len(chunks))])
    return {"id": source_id, "name": filename, "chunks": len(chunks)}


@app.delete("/api/sources/{source_id}")
async def delete_source(source_id: str):
    collection.delete(where={"source_id": source_id})
    return {"ok": True}


@app.post("/api/chat")
async def chat(body: ChatRequest):
    query = body.message.strip()
    if not query:
        raise HTTPException(400, "Write a message first.")
    result = collection.query(query_texts=[query], n_results=5,
                              include=["documents", "metadatas", "distances"])
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    # Chroma's cosine distance approaches 2 for unrelated vectors. Keep the
    # retrieval set focused so marginal passages do not swamp the answer.
    selected = [(doc, meta or {}, distance) for doc, meta, distance in zip(docs, metas, distances)
                if distance is None or distance < 0.85]
    citations: list[dict[str, str]] = []
    context_parts = []
    seen: set[str] = set()
    for doc, meta, _ in selected:
        src = source_label(meta)
        if src["id"] not in seen:
            citations.append(src)
            seen.add(src["id"])
        context_parts.append(f"[{src['name']}]\n{doc}")

    if not context_parts:
        return {"answer": "I don't have a matching source in your library yet. Add a document and ask me again.",
                "sources": [], "mode": "retrieval"}

    context = "\n\n---\n\n".join(context_parts)
    prompt = ("Answer the user's question using only the supplied private notes. Be concise and useful. "
              "If the notes don't contain the answer, say so. Refer to source filenames when helpful.\n\n"
              f"PRIVATE NOTES:\n{context}\n\nQUESTION:\n{query}")
    try:
        async with httpx.AsyncClient(timeout=90) as session:
            response = await session.post(f"{OLLAMA_URL.rstrip('/')}/api/chat", json={
                "model": OLLAMA_MODEL,
                "messages": [{"role": "system", "content": "You answer from retrieved notes only."},
                             *[m for m in body.history if m.get("role") in {"user", "assistant"}][-8:],
                             {"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.2},
            })
            response.raise_for_status()
            answer = response.json().get("message", {}).get("content", "").strip()
            if answer:
                return {"answer": answer, "sources": citations, "mode": "ollama"}
    except (httpx.HTTPError, ValueError):
        pass

    best_doc, best_meta, _ = selected[0]
    excerpt = best_doc[:650].rstrip()
    if len(best_doc) > 650:
        excerpt += "…"
    return {"answer": ("I found a relevant passage, but a local language model is not connected, "
                        "so I can't synthesize an answer yet. Start Ollama and try again.\n\n"
                        f"**Best match · {source_label(best_meta)['name']}**\n{excerpt}"),
            "sources": citations, "mode": "retrieval"}


@app.exception_handler(Exception)
async def safe_errors(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return JSONResponse(status_code=500, content={"detail": "Something went wrong while processing this request."})
