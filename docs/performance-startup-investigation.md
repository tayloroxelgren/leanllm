# LeanLLM performance and startup investigation

_Date: 2026-09-15 · Branch: `perf/startup-investigation` · Node: v22.23.1_

## Executive summary

LeanLLM starts quickly and its browser payload is small. The important risks are **streaming frontend rendering**, **full-file JSON persistence**, and **unbounded model/context work**. They do not prevent the app from working today, but they become user-visible jank and latency as conversations and history grow.

At current scale, the server is healthy:

- Empty-data server readiness: **42 ms p50**.
- A 21.1 MB conversations file raises readiness to **90 ms p50**.
- Initial browser payload: **70.3 KB raw / 17.9 KB gzip**.
- Local static/API throughput is in the thousands of requests/sec on the test host.

Highest-value work:

1. Stop rebuilding and re-parsing the complete assistant message on every token.
2. Stop serializing/rewriting every conversation for each store mutation.
3. Propagate browser aborts to Ollama/MCP and add upstream timeouts.
4. Bound prompt history and stored tool output.

## Method and environment

- Host: WSL2, AMD Ryzen 7 5800X, 16 GiB RAM, mostly idle.
- Startup: 15 samples after one warmup; measured from immediately before `spawn(node server.js)` until `/api/health` returned 200.
- Store files used synthetic 1 KB messages.
- HTTP: 1,000 keep-alive requests at concurrency 20 unless noted.
- Chat: local mock Ollama emitting 200 one-character NDJSON deltas; 100 requests at concurrency 10. This measures app overhead, not model inference.
- Markdown: renderer invoked against every cumulative prefix of a 17.7 KB response, simulating full re-render per streamed delta.

## Server startup

| Scenario | File size | p50 | p95 | Mean |
|---|---:|---:|---:|---:|
| Baseline `node --eval '""'` | n/a | 14.9 ms | 17.6 ms | 15.0 ms |
| Empty history | 0 B | 42.2 ms | 49.3 ms | 42.1 ms |
| Small history | 529 KB | 41.4 ms | 43.8 ms | 41.7 ms |
| Large history | 21.1 MB | 89.6 ms | 102.8 ms | 90.8 ms |

The application adds only **~27 ms** over the Node baseline with empty data. A CPU profile shows the active time spread across ESM/internal module loading, including `fetch`/undici, with no application-level startup hotspot. The server does not contact Ollama or Exa during startup; both clients are correctly lazy.

`ConversationStore.load()` is memoized, so repeated `await store.load()` calls do not repeat disk reads. The top-level startup load is not currently significant, but its cost is proportional to the entire monolithic conversation database.

## Frontend initial load

| Resource | Raw | Gzip |
|---|---:|---:|
| `index.html` | 7.5 KB | 2.5 KB |
| `index.css` | 20.2 KB | 4.6 KB |
| `markdown.js` | 9.4 KB | 2.9 KB |
| `app.js` | 33.2 KB | 7.9 KB |
| **Total** | **70.3 KB** | **17.9 KB** |

Initial load is already healthy:

- CSS is small and render-blocking, but only ~4.6 KB compressed.
- Both scripts use `defer`.
- The inline theme script avoids theme flash without another blocking resource.
- The favicon is inline and there are no fonts or runtime frameworks.
- `loadModels()` and `loadConversations()` start concurrently.
- External service slowness cannot block the server from accepting static assets.

Bundling or introducing a framework is not justified by initial payload.

## HTTP endpoint results

These are relative local-loopback results, not production capacity estimates.

| Path | Requests/sec | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| `GET /` | 2,996 | 6.1 ms | 8.7 ms | 19.3 ms |
| `GET /api/health` | 6,489 | 2.5 ms | 4.9 ms | 11.0 ms |
| `GET /assets/app.js` | 3,659 | 5.2 ms | 6.1 ms | 10.5 ms |
| `GET /api/conversations` (empty) | 6,353 | 2.6 ms | 5.1 ms | 11.9 ms |
| `GET /api/models` via mock Ollama | 2,652 | 7.0 ms | 9.7 ms | 31.1 ms |

Static and memoized API paths are fast. `/api/models` necessarily performs a proxied upstream request per call and should not be called more often than the UI requires.

## CommonJS startup follow-up

After this investigation, the server-only modules were converted from ESM to
CommonJS by renaming them to `.cjs`. The browser scripts remain unchanged, and
the package remains ESM for tests/browser assets. Conversation data is still
loaded before `listen()` to preserve existing readiness semantics.

Using the same 15-sample startup methodology:

| Scenario | ESM baseline p50 | CommonJS p50 | Difference |
|---|---:|---:|---:|
| Empty history | 42.2 ms | 25.1 ms | -17.1 ms |
| 529 KB history | 41.4 ms | 27.5 ms | -13.9 ms |
| 21.1 MB history | 89.6 ms | 96.8 ms | +7.2 ms |

The empty-data result exceeded the original estimate because the benchmark
includes spawning and HTTP health-check overhead. CommonJS avoids the ESM module
loading path and moves the minimal HTTP floor from roughly 35 ms to roughly
20 ms. The 21.1 MB result is noisy because JSON parsing dominates and synthetic
data varies in cache behavior between runs; lazy/background loading is the better
fix for large histories.

## Chat proxy overhead

The mock emitted 200 NDJSON deltas per response:

| Path | Requests/sec | p50 | p90 | p95 |
|---|---:|---:|---:|---:|
| Direct mock Ollama | 2,226 | 3.2 ms | 9.4 ms | 11.8 ms |
| Through `/api/chat` | 735 | 11.9 ms | 22.6 ms | 26.1 ms |

The app adds about **8.7 ms p50** and reduces this tiny non-model workload's throughput by **67%**. Real inference will often hide this for one user, but persistence and frontend handling amplify it for larger histories and concurrent users.

The NDJSON parser itself is straightforward. The larger costs are repeated store rewrites and frontend re-renders.

## Persistence findings

`ConversationStore` keeps every conversation in one JSON file. Every mutation serializes all conversations and performs temp-file write plus rename. Writes are serialized through one queue.

| File size | Full load | List summaries | One full rewrite |
|---:|---:|---:|---:|
| 529 KB | 1.6 ms | 0.13 ms | 2.8 ms |
| 4.2 MB | 7.7 ms | 0.09 ms | 12.5 ms |
| 21.1 MB | 54.5 ms | 0.41 ms | 101.8 ms |

An ordinary one-turn chat calls `save()` at least five times:

1. create conversation,
2. update model/search flag,
3. add user message,
4. add assistant placeholder,
5. store final assistant content.

At 21 MB, five queued full rewrites can occupy the write queue for roughly **500 ms**. A web-search turn adds more rewrites for tool-call state, search state, and tool output. Concurrent chats share that queue.

Other consequences:

- Startup load grows with every conversation.
- Synchronous store methods fire `save()` without awaiting it, so a response can finish before the final rename.
- A process exit during queued writes can lose recently accepted changes.
- There is no compaction or per-conversation isolation.

### Store recommendations

1. Mark conversations dirty and coalesce writes per macrotask/response phase.
2. Batch initial conversation/message creation into one logical mutation.
3. Move to per-conversation files plus a small index, or SQLite/WAL when scaling justifies it.
4. Add a durable flush point before `done` if accepted-but-unwritten messages are unacceptable.
5. Cap stored tool output separately from display-only source-card fields.

## Streaming frontend findings

For every content or thinking delta, `handleChatEvent()` creates a complete assistant node:

1. It renders the entire accumulated content with the custom markdown parser.
2. It assigns the complete HTML string to `innerHTML`.
3. It replaces the prior assistant DOM subtree.
4. It creates new detail/scroll listeners.
5. It reads `scrollHeight`, `scrollTop`, and `clientHeight`, forcing layout, then scrolls.

This is quadratic in text size and causes repeated style/DOM invalidation. Repeatedly rendering every 4-byte cumulative prefix of the 17.7 KB markdown sample produced 4,425 parser renders and **2.84 s** CPU time. That excludes HTML parsing, DOM replacement, layout, paint, listener allocation, and GC, so real browser cost is higher.

| Delta size | Renders | Total parser CPU | Mean parser CPU |
|---:|---:|---:|---:|
| 4 bytes | 4,425 | 2.84 s | 0.64 ms |
| 16 bytes | 1,106 | 0.68 s | 0.62 ms |
| 64 bytes | 276 | 0.17 s | 0.63 ms |

### Streaming recommendations

1. Keep one stable assistant DOM node for the whole stream.
2. Buffer deltas and render on `requestAnimationFrame` or a 50–100 ms cadence.
3. During streaming, append escaped text or update only the last stable markdown block.
4. Run complete markdown rendering once when the model reports `done`.
5. Coalesce scroll measurement and scrolling in the same frame.
6. Preserve thinking scroll/listener state rather than recreating it.

## Additional client findings

`renderConversationList()` rebuilds every item on every filter keystroke and after every send. `renderModels()` does the same while filtering models. This is acceptable for tens of items but can cause typing latency with hundreds. Debounce filters by 75–150 ms and reuse/update DOM nodes.

`renderConversation()` recreates all messages on new chat, open, stream start, and stream completion. After a stream, the UI also fetches the conversation list and full saved conversation. For long conversations this creates avoidable final jank. Update the final assistant node in place and reserve full render for opening a different conversation. Add pagination/virtualization only for very large histories.

The stylesheet is small and mostly uses transform/opacity animations. The persistent composer's `backdrop-filter: blur(12px)` can be expensive on low-end GPUs while children change every frame; measure target hardware before changing the visual design.

## Context and external request findings

The server sends the full saved history to Ollama every turn and keeps appending tool outputs during the tool loop. There is no context-window accounting, trimming, summarization, or tool-output cap. User-perceived latency therefore grows with conversation age and can eventually exceed the model context.

Ollama and MCP requests have no timeout or abort signal. Browser abort/stop is not explicitly propagated upstream, so local generation and web tools can continue after the user stops. `modelSupportsThinking()` also adds an upstream request before the first chat with each model and caches both positive and negative results forever.

Recommendations:

1. Create one `AbortController` per chat and abort it on `req.close`.
2. Pass the signal to Ollama, MCP initialization, and tool calls.
3. Add conservative connect/body timeouts and actionable errors.
4. Estimate context length, trim deterministically, and tell the user when older context is omitted.
5. Give thinking-capability cache entries a TTL or refresh them on model reload.

## Lower-priority HTTP opportunities

- Add gzip/brotli when not handled by a reverse proxy.
- Use immutable content-hashed asset names instead of manual query-string versions.
- Add `ETag` support where useful.
- Preserve the current HTML `no-cache` versus asset-cache separation.

## Priorities

### P0

1. Incremental or throttled streaming renderer with one stable DOM node.
2. Dirty/conversation-scoped persistence with coalesced writes.
3. Abort and timeout propagation for Ollama and MCP.

### P1

1. Bound prompt history and tool output.
2. Debounce and reconcile sidebar/model lists.
3. Avoid the post-stream full reload/render.
4. Add compression and immutable assets when running without a proxy.
5. Add TTL/refresh behavior to capability caches.

### P2

1. Add metrics for upstream first byte, full stream, store flush, and tool calls.
2. Add CI budgets for startup readiness, asset size, and markdown render time.
3. Re-run benchmarks with representative conversations and target browsers.

## Baseline validation

Before adding this report-only change:

```text
npm test
Syntax checks passed.
1 test passed, 0 failed.
```

No runtime code was changed in this investigation.
