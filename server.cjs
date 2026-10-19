const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { PDFParse } = require('pdf-parse');
const { ConversationStore } = require('./lib/store.cjs');
const { ExaMcpClient } = require('./lib/mcp-client.cjs');
const { parseSearchResults } = require('./lib/search-results.cjs');

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const dataDir = process.env.LEANLLM_DATA_DIR || path.join(root, 'data');
const imagesDir = path.join(dataDir, 'images');
const documentsDir = path.join(dataDir, 'documents');
const maxBodyBytes = Number(process.env.LEANLLM_MAX_BODY_MB || 160) * 1024 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
const maxPdfBytes = 40 * 1024 * 1024;
const store = new ConversationStore(path.join(dataDir, 'conversations.json'));
const exa = new ExaMcpClient({
  apiKey: process.env.EXA_API_KEY,
  endpoint: process.env.EXA_MCP_URL
});
const defaultOllamaHost = process.env.OLLAMA_HOST || 'http://10.0.0.247:11434';
const modelCapabilities = new Map();
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
    if (size > maxBodyBytes) throw Object.assign(new Error('Payload too large'), { status: 413 });
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

function buildSystemPrompt(customPrompt = '', webSearchEnabled = false) {
  const timestamp = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(new Date());
  return [
    customPrompt.trim(),
    ...(webSearchEnabled ? [
      'Web research policy: Use the available web search tool frequently.',
      'Search whenever a question could benefit from current, local, changing, specialized, or uncertain information,',
      'including news, prices, software, laws, people, places, events, standards, or anything after your training cutoff.',
      'When in doubt, search first rather than relying on memory. Fetch promising pages when search highlights are insufficient,',
      'then ground your answer in the results and cite the URLs you used.'
    ].join(' ') : []),
    `Current date and time: ${timestamp}. Treat this timestamp as authoritative for the current date.`
  ].filter(Boolean).join('\n\n');
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

async function modelCapabilitiesFor(baseUrl, model) {
  const key = `${baseUrl}|${model}`;
  if (modelCapabilities.has(key)) return modelCapabilities.get(key);
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!response.ok) throw new Error(await response.text());
    const info = JSON.parse(await response.text());
    const supported = new Set(Array.isArray(info.capabilities) ? info.capabilities : []);
    modelCapabilities.set(key, supported);
    return supported;
  } catch (error) {
    console.warn(`Unable to inspect capabilities for ${model}:`, error.message);
    const unsupported = new Set();
    modelCapabilities.set(key, unsupported);
    return unsupported;
  }
}

function validateImage(value, index) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i);
  const base64 = (match ? match[2] : raw).replace(/\s+/g, '');
  const decoded = Buffer.from(base64, 'base64');
  if (!base64 || base64.length % 4 || !decoded.length) {
    throw Object.assign(new Error(`Image ${index + 1} is not valid base64`), { status: 400 });
  }
  const encodedLength = Math.ceil(decoded.length / 3) * 4;
  if (decoded.length > maxImageBytes || base64.length > encodedLength) {
    throw Object.assign(new Error(`Image ${index + 1} is too large (5 MB maximum)`), { status: 413 });
  }
  const extension = detectImageType(decoded);
  if (!extension) {
    throw Object.assign(new Error(`Image ${index + 1} must be JPEG, PNG, or WebP`), { status: 415 });
  }
  return {
    decoded,
    extension
  };
}

function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

async function saveImageFile(decoded, extension) {
  await fsp.mkdir(imagesDir, { recursive: true });
  const name = `${crypto.randomUUID()}.${extension}`;
  await fsp.writeFile(path.join(imagesDir, name), decoded);
  return `/api/images/${name}`;
}

async function normalizedImages(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw Object.assign(new Error('Images must be an array'), { status: 400 });
  if (values.length > 20) throw Object.assign(new Error('A message can include at most 20 images'), { status: 400 });
  const saved = [];
  for (const [index, value] of values.entries()) {
    const raw = String(value || '');
    if (/^\/api\/images\/[A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp)$/.test(raw)) {
      // Uploaded by the client to disk already; keep the reference.
      saved.push(raw);
      continue;
    }
    // Legacy inline data URLs from before the disk-backed store.
    const { decoded, extension } = validateImage(value, index);
    saved.push(await saveImageFile(decoded, extension));
  }
  return saved;
}

// Streams a raw image body to disk in chunks: only one ~64 KB chunk is ever
// in memory, and the 5 MB limit is enforced while streaming.
async function uploadImage(req, res) {
  await fsp.mkdir(imagesDir, { recursive: true });
  const tempPath = path.join(imagesDir, `.upload-${process.pid}-${Date.now()}`);
  const out = fs.createWriteStream(tempPath);
  let size = 0;
  let header = Buffer.alloc(0);
  let extension = null;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxImageBytes) throw Object.assign(new Error('Image is too large (5 MB maximum)'), { status: 413 });
      if (!extension) {
        header = Buffer.concat([header, chunk]);
        if (header.length >= 12) {
          extension = detectImageType(header.subarray(0, 16));
          if (!extension) throw Object.assign(new Error('Image must be JPEG, PNG, or WebP'), { status: 415 });
        }
      }
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
    }
    if (!extension) extension = detectImageType(header);
    if (!size || !extension) throw Object.assign(new Error('Image must be JPEG, PNG, or WebP'), { status: 415 });
    await new Promise(resolve => out.end(resolve));
    const name = `${crypto.randomUUID()}.${extension}`;
    await fsp.rename(tempPath, path.join(imagesDir, name));
    json(res, 201, { url: `/api/images/${name}` });
  } catch (error) {
    out.destroy();
    await fsp.rm(tempPath, { force: true });
    json(res, error.status || 400, { error: error.message || 'Image upload failed' });
  }
}

// Yields the image as base64 text in ~64 KB pieces, reading from disk one
// chunk at a time so only the image currently being sent occupies memory.
async function* imageBase64Chunks(ref) {
  const raw = String(ref);
  if (raw.startsWith('data:')) {
    const base64 = raw.replace(/^data:[^,]+,/, '');
    for (let index = 0; index < base64.length; index += 1 << 20) {
      yield base64.slice(index, index + (1 << 20));
    }
    return;
  }
  let carry = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(path.join(imagesDir, path.basename(raw)), { highWaterMark: 49152 })) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const remainder = buffer.length % 3;
    carry = Buffer.from(buffer.subarray(buffer.length - remainder));
    const whole = buffer.subarray(0, buffer.length - remainder);
    if (whole.length) yield whole.toString('base64');
  }
  if (carry.length) yield carry.toString('base64');
}

// Emits the chat request JSON incrementally so image bytes stream straight
// from disk into the request; the body is never assembled in memory.
async function* chatRequestBodyChunks(body) {
  yield `{"model":${JSON.stringify(body.model)},"messages":[`;
  let first = true;
  for (const message of body.messages) {
    yield `${first ? '' : ','}{"role":${JSON.stringify(message.role)},"content":${JSON.stringify(message.content ?? '')}`;
    first = false;
    if (message.tool_calls?.length) yield `,"tool_calls":${JSON.stringify(message.tool_calls)}`;
    const images = message.images || [];
    if (images.length) {
      yield ',"images":[';
      let separator = '';
      for (const image of images) {
        yield `${separator}"`;
        separator = ',';
        yield* imageBase64Chunks(image);
        yield '"';
      }
      yield ']';
    }
    yield '}';
  }
  let tail = '],"stream":true';
  if (body.think) tail += ',"think":true';
  tail += `,"options":{"temperature":${JSON.stringify(body.options.temperature)},"top_p":${JSON.stringify(body.options.top_p)}}`;
  if (body.tools) tail += `,"tools":${JSON.stringify(body.tools)}`;
  yield `${tail}}`;
}

async function sendOllamaChat(baseUrl, body) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  try {
    return await fetch(`${ollamaBase(baseUrl)}/api/chat`, {
      ...init,
      body: Readable.toWeb(Readable.from(chatRequestBodyChunks(body))),
      duplex: 'half'
    });
  } catch (error) {
    // Older Node runtimes reject streamed request bodies; assemble once there.
    if (!(error instanceof TypeError)) throw error;
    const chunks = [];
    for await (const chunk of chatRequestBodyChunks(body)) chunks.push(Buffer.from(chunk));
    return fetch(`${ollamaBase(baseUrl)}/api/chat`, { ...init, body: Buffer.concat(chunks) });
  }
}

function imageRefs(conversation) {
  return (conversation?.messages || [])
    .flatMap(message => message.images || [])
    .filter(value => String(value).startsWith('/api/images/'))
    .map(value => path.basename(String(value)));
}

async function pruneImages(conversation) {
  for (const name of imageRefs(conversation)) {
    const stillUsed = store.list().some(item => {
      if (item.id === conversation.id) return false;
      return imageRefs(store.get(item.id)).includes(name);
    });
    if (!stillUsed) await fsp.rm(path.join(imagesDir, name), { force: true });
  }
}

// Streams a raw PDF body to disk, extracts text per page, and stores the
// result as JSON. Only one chunk of the PDF is in memory at a time during
// upload; the full buffer is loaded once for text extraction.
async function uploadDocument(req, res) {
  await fsp.mkdir(documentsDir, { recursive: true });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxPdfBytes) throw Object.assign(new Error('PDF is too large (40 MB maximum)'), { status: 413 });
      chunks.push(chunk);
    }
    const pdf = Buffer.concat(chunks);
    if (!pdf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw Object.assign(new Error('File must be a PDF'), { status: 415 });
    }
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    await parser.load();
    const result = await parser.getText();
    await parser.destroy();
    const pages = (result.pages || []).map(page => ({
      num: page.num,
      text: page.text || ''
    }));
    if (!pages.length) throw Object.assign(new Error('No extractable text found in PDF'), { status: 422 });
    const name = `${crypto.randomUUID()}.json`;
    const body = JSON.stringify({ pages, total: pages.length });
    await fsp.writeFile(path.join(documentsDir, name), body);
    json(res, 201, { url: `/api/documents/${name}`, pages: pages.length });
  } catch (error) {
    json(res, error.status || 400, { error: error.message || 'PDF upload failed' });
  }
}

async function normalizedDocuments(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw Object.assign(new Error('Documents must be an array'), { status: 400 });
  if (values.length > 10) throw Object.assign(new Error('A message can include at most 10 documents'), { status: 400 });
  const saved = [];
  for (const value of values) {
    const raw = String(value || '');
    if (/^\/api\/documents\/[A-Za-z0-9-]+\.json$/.test(raw)) {
      saved.push(raw);
      continue;
    }
    throw Object.assign(new Error('Invalid document reference'), { status: 400 });
  }
  return saved;
}

async function readDocumentText(ref) {
  const raw = String(ref);
  const file = path.join(documentsDir, path.basename(raw));
  const data = JSON.parse(await fsp.readFile(file, 'utf8'));
  return (data.pages || [])
    .map(page => `--- Page ${page.num} ---\n${page.text}`)
    .join('\n\n');
}

function documentRefs(conversation) {
  return (conversation?.messages || [])
    .flatMap(message => message.documents || [])
    .filter(value => String(value).startsWith('/api/documents/'))
    .map(value => path.basename(String(value)));
}

async function pruneDocuments(conversation) {
  for (const name of documentRefs(conversation)) {
    const stillUsed = store.list().some(item => {
      if (item.id === conversation.id) return false;
      return documentRefs(store.get(item.id)).includes(name);
    });
    if (!stillUsed) await fsp.rm(path.join(documentsDir, name), { force: true });
  }
}

async function chat(req, res) {
  const input = await readJson(req);
  let images;
  let documents;
  try {
    images = await normalizedImages(input.images);
    documents = await normalizedDocuments(input.documents);
  } catch (error) {
    return json(res, error.status || 400, { error: error.message });
  }
  if (!input.message?.trim() && !images.length && !documents.length) {
    return json(res, 400, { error: 'A message, image, or document is required' });
  }

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
  if (!input.message?.trim() && conversation.title === 'New chat') {
    store.update(conversation.id, { title: `Image chat · ${new Date().toLocaleDateString()}` });
  }
  const user = store.addMessage(conversation.id, {
    role: 'user',
    content: input.message?.trim() || '',
    ...(images.length ? { images } : {}),
    ...(documents.length ? { documents } : {})
  });

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
    const capabilities = await modelCapabilitiesFor(baseUrl, input.model);
    const supportsThinking = capabilities.has('thinking');
    const supportsVision = capabilities.has('vision');
    // Pre-read all document texts so the context mapping stays synchronous.
    const documentTexts = new Map();
    for (const message of conversation.messages) {
      for (const ref of message.documents || []) {
        if (!documentTexts.has(ref)) {
          try {
            documentTexts.set(ref, await readDocumentText(ref));
          } catch {
            documentTexts.set(ref, '[Document content unavailable]');
          }
        }
      }
    }
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
        let content = message.content || '';
        if (message.role === 'user' && message.documents?.length) {
          const docBlocks = message.documents.map(ref => {
            const text = documentTexts.get(ref) || '[Document content unavailable]';
            return `[Attached document]\n${text}`;
          });
          content = docBlocks.join('\n\n') + (content ? `\n\n${content}` : '');
        }
        const normalized = { role: message.role, content };
        if (message.role === 'user' && message.images?.length && supportsVision) {
          normalized.images = message.images;
        }
        return normalized;
      });
    context.unshift({ role: 'system', content: buildSystemPrompt(input.systemPrompt, conversation.webSearch) });

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
      const response = await sendOllamaChat(input.ollamaUrl, requestBody);
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
      if (req.method === 'DELETE') {
        const conversation = store.get(match[1]);
        const removed = store.remove(match[1]);
        if (removed && conversation) {
          await pruneImages(conversation);
          await pruneDocuments(conversation);
        }
        return json(res, removed ? 204 : 404);
      }
    }
    match = url.pathname.match(/^\/api\/images\/([A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp))$/);
    if (match && req.method === 'GET') {
      const file = path.join(imagesDir, match[1]);
      try {
        const stat = await fsp.stat(file);
        const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
        res.writeHead(200, {
          'content-type': types[path.extname(file).toLowerCase()],
          'content-length': stat.size,
          'cache-control': 'public, max-age=31536000, immutable'
        });
        fs.createReadStream(file).pipe(res);
        return;
      } catch {
        return send(res, 404, 'Not found');
      }
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return await chat(req, res);
    if (url.pathname === '/api/images' && req.method === 'POST') return await uploadImage(req, res);
    if (url.pathname === '/api/documents' && req.method === 'POST') return await uploadDocument(req, res);
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
