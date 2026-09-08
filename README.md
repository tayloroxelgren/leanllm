# LeanLLM

A small, dependency-free chat UI for Ollama. It reproduces the useful parts of
the llama.cpp Web UI experience—conversation history, model discovery, streaming
Markdown, source cards, dark mode, and responsive layout—without a bundler or
JavaScript package tree.

## Quick start

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

## Architecture

- `server.js` — Node's built-in HTTP server, Ollama streaming proxy, MCP tool loop, and static file server
- `lib/mcp-client.js` — minimal MCP Streamable HTTP client (initialize / tools / call)
- `lib/search-results.js` — parser for Exa's MCP result format
- `lib/store.js` — atomic JSON conversation persistence
- `public/` — vanilla HTML, CSS, and browser JavaScript

There are no runtime npm dependencies. Conversations are stored in
`data/conversations.json`.
