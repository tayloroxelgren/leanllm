const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ConversationStore } = require('./lib/store.cjs');
const { ExaMcpClient } = require('./lib/mcp-client.cjs');
const { parseSearchResults } = require('./lib/search-results.cjs');

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const dataDir = process.env.LEANLLM_DATA_DIR || path.join(root, 'data');
const store = new ConversationStore(path.join(dataDir, 'conversations.json'));
const exa = new ExaMcpClient({
  apiKey: process.env.EXA_API_KEY,
  endpoint: process.env.EXA_MCP_URL
});
const defaultOllamaHost = process.env.OLLAMA_HOST || 'http://10.0.0.247:11434';
const thinkingModels = new Map();
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function ollamaBase(url) {
  const value = url || defaultOllamaHost;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid Ollama URL');
  return parsed.toString().replace(/\/+$/, '');
}

async function readOllama(pathname, options = {}, ollamaUrl) {
  const response = await fetch(`${ollamaBase(ollamaUrl)}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body || `Ollama returned ${response.status}`);
  return body;
}

function safeTitle(conversation) {
  return conversation.title || 'New chat';
}

async function webTools() {
  await exa.connect();
  const tools = exa.tools
    .filter(tool => ['web_search_exa', 'web_fetch_exa'].includes(tool.name))
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  if (!tools.some(tool => tool.function.name === 'web_search_exa')) {
    throw new Error('The configured Exa MCP server does not expose web_search_exa');
  }
  return tools;
}

async function searchWeb(query, event) {
  const started = Date.now();
  try {
    const text = await exa.callTool('web_search_exa', { query, numResults: 5 });
    const results = parseSearchResults(text);
    event({ type: 'search', state: 'complete', query, results, durationMs: Date.now() - started });
    if (!results.length) return text || 'No search results were returned.';
    return results.map((result, index) => {
      const lines = [`[${index + 1}] Title: ${result.title}`, `URL: ${result.url}`];
      if (result.published) lines.push(`Published: ${result.published}`);
      if (result.author) lines.push(`Author: ${result.author}`);
      lines.push('Highlights:', result.highlights || 'No excerpt was provided.');
      return lines.join('\n');
    }).join('\n---\n');
  } catch (error) {
    event({
      type: 'search',
      state: 'error',
      query,
      durationMs: Date.now() - started,
      error: error.message
    });
    throw new Error(`Web search failed: ${error.message}`);
  }
}

async function fetchPages(args, event) {
  const urls = (Array.isArray(args.urls) ? args.urls : String(args.urls || '').split(','))
    .map(url => String(url).trim())
    .filter(url => /^https?:\/\//i.test(url));
  if (!urls.length) throw new Error('web_fetch_exa was called without a valid URL');
  const started = Date.now();
  event({ type: 'fetch', state: 'running', urls });
  try {
    const output = await exa.callTool('web_fetch_exa', {
      urls,
      maxCharacters: Math.min(Number(args.maxCharacters || 3000), 8000)
    });
    event({ type: 'fetch', state: 'complete', urls, charCount: output.length, durationMs: Date.now() - started });
    return output;
  } catch (error) {
    event({ type: 'fetch', state: 'error', urls, error: error.message });
    throw new Error(`Web page fetch failed: ${error.message}`);
  }
}

async function modelSupportsThinking(baseUrl, model) {
  const key = `${baseUrl}|${model}`;
  if (thinkingModels.has(key)) return thinkingModels.get(key);
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!response.ok) throw new Error(await response.text());
    const info = JSON.parse(await response.text());
    const supports = Array.isArray(info.capabilities) && info.capabilities.includes('thinking');
    thinkingModels.set(key, supports);
    return supports;
  } catch (error) {
    console.warn(`Unable to inspect thinking support for ${model}:`, error.message);
    thinkingModels.set(key, false);
    return false;
  }
}

async function chat(req, res) {
  const input = await readJson(req);
  if (!input.message?.trim()) return json(res, 400, { error: 'Message is required' });

  let conversation = input.conversationId ? store.get(input.conversationId) : null;
  if (!conversation) {
    conversation = store.create({
      model: input.model,
      webSearch: Boolean(input.webSearch)
    });
  }
  store.update(conversation.id, {
    model: input.model,
    webSearch: Boolean(input.webSearch)
  });
  const user = store.addMessage(conversation.id, { role: 'user', content: input.message.trim() });

  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/x-ndjson; charset=utf-8',
    'x-accel-buffering': 'no'
  });
  const event = value => res.write(`${JSON.stringify(value)}\n`);
  event({ type: 'start', conversation, user });

  const assistant = store.addMessage(conversation.id, {
    role: 'assistant',
    content: '',
    thinking: '',
    model: input.model,
    searches: [],
    streaming: true
  });
  event({ type: 'assistant-created', id: assistant.id });

  let thinking = '';
  try {
    const baseUrl = ollamaBase(input.ollamaUrl);
    const supportsThinking = await modelSupportsThinking(baseUrl, input.model);
    let context = conversation.messages
      .filter(message => !message.error && !(message.id === assistant.id && message.streaming))
      .map(message => {
        if (message.role === 'assistant' && message.toolCalls?.length) {
          return { role: 'assistant', content: message.content || '', tool_calls: message.toolCalls };
        }
        if (message.role === 'search') {
          const output = message.toolOutput || (message.results || []).map((result, index) => {
            const lines = [`[${index + 1}] Title: ${result.title}`, `URL: ${result.url}`];
            if (result.highlights) lines.push('Highlights:', result.highlights);
            return lines.join('\n');
          }).join('\n---\n');
          return { role: 'tool', content: output, tool_name: 'web_search_exa' };
        }
        if (message.role === 'fetch') return { role: 'tool', content: message.toolOutput || message.content, tool_name: 'web_fetch_exa' };
        return { role: message.role, content: message.content };
      });
    if (input.systemPrompt?.trim()) context.unshift({ role: 'system', content: input.systemPrompt.trim() });

    for (let turn = 0; turn < 8; turn++) {
      const requestBody = {
        model: input.model,
        messages: context,
        stream: true,
        ...(supportsThinking ? { think: true } : {}),
        options: {
          temperature: Number(input.temperature ?? 0.7),
          top_p: Number(input.topP ?? 0.9)
        },
        ...(conversation.webSearch ? { tools: await webTools() } : {})
      };
      const response = await fetch(`${ollamaBase(input.ollamaUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `Ollama returned ${response.status}`);
      }

      let content = '';
      let toolCalls = [];
      const decoder = new TextDecoder();
      let buffer = '';

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let packet;
          try { packet = JSON.parse(line); } catch { continue; }
          if (packet.error) throw new Error(packet.error);
          const reasoning = packet.message?.thinking || '';
          if (reasoning) {
            thinking += reasoning;
            event({ type: 'thinking', id: assistant.id, content: reasoning });
          }
          const delta = packet.message?.content || '';
          if (delta) {
            content += delta;
            event({ type: 'delta', id: assistant.id, content: delta });
          }
          if (packet.message?.tool_calls?.length) toolCalls = packet.message.tool_calls;
          if (packet.done) {
            event({
              type: 'meta',
              id: assistant.id,
              totalDuration: packet.total_duration,
              evalCount: packet.eval_count
            });
          }
        }
      }

      if (toolCalls.length) {
        store.updateMessage(conversation.id, assistant.id, { toolCalls });
        event({ type: 'tool-calls', id: assistant.id, toolCalls });
        context.push({ role: 'assistant', content, tool_calls: toolCalls });

        for (const call of toolCalls) {
          const toolName = call.function?.name;
          let args;
          try {
            args = typeof call.function?.arguments === 'string'
              ? JSON.parse(call.function.arguments || '{}')
              : call.function?.arguments || {};
          } catch {
            throw new Error(`The model supplied invalid arguments to ${toolName}`);
          }

          if (toolName === 'web_search_exa') {
            const query = String(args.query || '').trim();
            if (!query) throw new Error('The model requested a search without a query');
            const searchMessage = store.addMessage(conversation.id, {
              role: 'search',
              content: '',
              query,
              results: [],
              state: 'running'
            });
            event({ type: 'search-created', id: searchMessage.id, query });
            const toolOutput = await searchWeb(query, payload => {
              if (payload.state === 'complete') {
                store.updateMessage(conversation.id, searchMessage.id, {
                  content: 'Search complete',
                  results: payload.results,
                  state: 'complete',
                  durationMs: payload.durationMs
                });
              } else {
                store.updateMessage(conversation.id, searchMessage.id, {
                  state: 'error',
                  error: payload.error
                });
              }
              event(payload);
            });
            store.updateMessage(conversation.id, searchMessage.id, { toolOutput });
            context.push({ role: 'tool', content: toolOutput, tool_name: toolName });
          } else if (toolName === 'web_fetch_exa') {
            const normalizedUrls = Array.isArray(args.urls) ? args.urls : [];
            const fetchMessage = store.addMessage(conversation.id, {
              role: 'fetch',
              content: '',
              urls: normalizedUrls,
              state: 'running'
            });
            event({ type: 'fetch-created', id: fetchMessage.id, urls: normalizedUrls });
            const toolOutput = await fetchPages(args, payload => {
              store.updateMessage(conversation.id, fetchMessage.id, {
                state: payload.state,
                durationMs: payload.durationMs,
                charCount: payload.charCount,
                error: payload.error
              });
              event(payload);
            });
            store.updateMessage(conversation.id, fetchMessage.id, { toolOutput });
            context.push({ role: 'tool', content: toolOutput, tool_name: toolName });
          } else {
            throw new Error(`This UI supports Exa web search and fetch only; received ${toolName}`);
          }
        }
        content = '';
        toolCalls = [];
        continue;
      }

      store.updateMessage(conversation.id, assistant.id, {
        content,
        thinking,
        streaming: false,
        error: content ? undefined : 'The model returned an empty response.'
      });
      event({ type: 'done', id: assistant.id, conversationId: conversation.id });
      res.end();
      return;
    }
    throw new Error('The model kept requesting searches without producing a response.');
  } catch (error) {
    const message = error.message || 'Chat request failed';
    store.updateMessage(conversation.id, assistant.id, { thinking, streaming: false, error: message });
    event({ type: 'error', id: assistant.id, error: message });
    res.end();
  }
}

async function serveStatic(pathname, res) {
  if (pathname === '/') pathname = '/index.html';
  const requested = path.normalize(path.join(root, 'public', pathname));
  if (!requested.startsWith(path.join(root, 'public'))) return send(res, 403, 'Forbidden');
  try {
    const stat = await fsp.stat(requested);
    if (!stat.isFile()) throw new Error();
    const ext = path.extname(requested).toLowerCase();
    const cache = pathname.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': cache });
    fs.createReadStream(requested).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'DELETE, GET, POST, PATCH, OPTIONS',
        'access-control-allow-origin': '*'
      });
      return res.end();
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(url.pathname, res);
    }

    await store.load();
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, webSearch: 'exa-mcp' });
    }
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const body = await readOllama('/api/tags', {}, url.searchParams.get('ollamaUrl'));
      const models = JSON.parse(body).models?.map(model => ({
        name: model.name,
        size: model.size,
        modifiedAt: model.modified_at,
        family: model.details?.family,
        parameterSize: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        contextLength: model.details?.context_length,
        capabilities: model.capabilities || []
      })) || [];
      return json(res, 200, { models });
    }
    if (url.pathname === '/api/conversations' && req.method === 'GET') return json(res, 200, { conversations: store.list() });
    if (url.pathname === '/api/conversations' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 201, store.create(body));
    }
    let match = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (match) {
      if (req.method === 'GET') {
        const conversation = store.get(match[1]);
        return conversation ? json(res, 200, conversation) : json(res, 404, { error: 'Conversation not found' });
      }
      if (req.method === 'PATCH') return json(res, 200, store.update(match[1], await readJson(req)));
      if (req.method === 'DELETE') return json(res, store.remove(match[1]) ? 204 : 404);
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return await chat(req, res);
    return json(res, 404, { error: 'API route not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message });
    else res.end();
  }
});

store.load().then(() => {
  server.listen(port, () => {
    console.log(`LeanLLM ready: http://localhost:${port}`);
    console.log(`Data: ${dataDir}`);
  });
}).catch(error => {
  console.error('Unable to initialize conversations:', error);
  process.exitCode = 1;
});
