# Morrow · Personal Knowledge Assistant

A local-first Python app for searching your personal documents and asking questions grounded in them. The interface is intentionally simple: add a few files, ask a question, and follow the source chips back to the documents that informed the answer.

## Run it

Requires Python 3.10+. From this folder:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). On first startup, the embedding model is downloaded once from Hugging Face and cached locally. Documents and the Chroma vector index are stored in `data/` beside the app.

### Enable synthesized answers with Ollama

Ollama is a separate local application; it is not installed by `pip install -r requirements.txt`. On macOS:

1. Install [Ollama for macOS](https://ollama.com/download/mac) and open the Ollama app.
2. Open a new Terminal window and download the default model:

   ```bash
   ollama pull llama3.2
   ```

3. Confirm it is installed:

   ```bash
   ollama list
   ```

4. Restart Morrow and ask your question again. Ollama should be available at `http://127.0.0.1:11434`.

If the terminal reports `command not found: ollama`, finish installing Ollama, open the app, and open a new Terminal window. If Ollama uses a different local endpoint or model, set `OLLAMA_URL` and `OLLAMA_MODEL`. Without Ollama, retrieval still works and the app displays the best matching passage, but it cannot synthesize an answer.

## What it does

- Indexes PDF, DOCX, Markdown, and plain text files into a persistent Chroma vector database.
- Splits documents into overlapping chunks and retrieves relevant passages for each question.
- Uses a local Ollama model when available. The prompt contains retrieved passages and asks the model to stay grounded in them.
- Shows source filenames alongside answers; supports removing sources from the library.
- Keeps app data on disk locally. The server binds to loopback by default; do not expose it to a network without adding authentication and transport security.

## Privacy notes

The app does not send uploaded documents to a hosted service. The sentence-transformers embedding model runs locally after its initial download. If Ollama is running locally, generation also stays local. If it is unavailable, the app falls back to showing retrieved excerpts. Choose only documents you are comfortable keeping on this computer; anyone with access to your OS account can access the local data folder. Delete the `data/` directory to remove the local index and stored vectors.

Supported uploads are limited to 100 MB per file. Scanned PDFs without an embedded text layer need OCR before upload. This starter app is intended for one trusted local user, not a multi-user deployment.
