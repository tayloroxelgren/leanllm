# LeanLLM

A small chat UI for Ollama.

## Quick start

Requires Node.js 18 or newer. Install the runtime dependencies once:

```bash
npm install
```

Then start the server:

```bash
npm start
```

Then open <http://localhost:5173>.

By default the server looks for Ollama at `http://10.0.0.247:11434`. Change it
from Settings in the UI, or start with:

```bash
OLLAMA_HOST=http://127.0.0.1:11434 npm start
```

For a custom UI port or data directory:

```bash
PORT=8080 LEANLLM_DATA_DIR=/tmp/leanllm npm start
```

## Web search

The Search toggle exposes the same recommended Exa MCP server used by llama.cpp's
UI (`https://mcp.exa.ai/mcp`) to a tool-capable Ollama model. No Exa key is
required for the public endpoint. The model can call:

- `web_search_exa` for live web results
- `web_fetch_exa` when it needs full page content

Search results are retained with the conversation as collapsed source cards; click
a card to inspect its links and excerpts.
No client-side search package is required. If your Exa plan requires an
authenticated key, set:

```bash
EXA_API_KEY=your_key npm start
```

Pick a model showing a `tools` badge in the model picker for the best experience.

## Thinking

LeanLLM detects models that advertise Ollama's `thinking` capability and requests
the reasoning stream automatically. The reasoning appears as a collapsed
**Thinking** block above the answer. You can expand or collapse it at any time
to follow or review the stream.

## Attachments

Use **Attach** to include images and PDFs with a message; you can also paste or
drag files into the composer.

### Images

Models that advertise Ollama's `vision` capability can receive JPEG, PNG, or
WebP images. Images are uploaded to the server, referenced by the saved
conversation, and streamed to Ollama during chat so follow-up questions can
refer to them. A message can include up to 20 images, each up to 5 MB.

### PDFs

Attach PDFs to any chat, including with models that do not support vision.
LeanLLM extracts the PDF text by page and includes that text in the model
context. A message can include up to 10 PDFs, each up to 40 MB, and the server
rejects PDFs that contain no extractable text. Extracted content is retained
with the conversation so follow-up questions can refer to the document.

## Architecture

- `server.cjs` — Node's built-in HTTP server, Ollama streaming proxy, MCP tool loop, and static file server
- `lib/mcp-client.cjs` — minimal MCP Streamable HTTP client (initialize / tools / call)
- `lib/search-results.cjs` — parser for Exa's MCP result format
- `lib/store.cjs` — atomic JSON conversation persistence
- `public/` — vanilla HTML, CSS, and browser JavaScript

`pdf-parse` is the runtime npm dependency used for PDF text extraction.

Conversations are stored in `data/conversations.json`. Uploaded images are
stored under `data/images/`, and extracted PDF text is stored under
`data/documents/`. Deleting a conversation prunes attachments that are no
longer referenced.

## Upgrading existing data

If you have conversations created before images moved to disk, stop the server
and run the one-time migration:

```bash
node scripts/extract-images.cjs
```

The script moves inline base64 images into `data/images/`, keeps a timestamped
backup of `conversations.json`, and is safe to run again if there is nothing to
migrate.

---
<small>This was all vibed</small>
