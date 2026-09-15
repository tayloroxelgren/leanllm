const PROTOCOL_VERSION = '2025-06-18';

function jsonSseMessage(raw) {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try { return JSON.parse(payload); } catch { /* keep scanning */ }
    }
  }
  return null;
}

async function rpc(url, body, sessionId) {
  const headers = {
    'accept': 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Exa MCP ${response.status}: ${detail.slice(0, 240) || response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const message = contentType.includes('text/event-stream')
    ? jsonSseMessage(text)
    : text.trim() ? JSON.parse(text) : null;
  if (message?.error) throw new Error(message.error.message || 'Exa MCP request failed');
  return { message, sessionId: response.headers.get('mcp-session-id') || sessionId };
}

class ExaMcpClient {
  constructor({ endpoint, apiKey } = {}) {
    this.endpoint = new URL(endpoint || 'https://mcp.exa.ai/mcp');
    if (apiKey) this.endpoint.searchParams.set('exaApiKey', apiKey);
    this.sessionId = null;
    this.nextId = 1;
    this.connecting = null;
  }

  async connect() {
    if (this.ready) return;
    this.connecting ||= (async () => {
      const { message, sessionId } = await rpc(this.endpoint, {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          clientInfo: { name: 'leanllm-mcp', version: '1.0.0' }
        }
      });
      this.serverInfo = message?.result?.serverInfo;
      this.sessionId = sessionId;
      await rpc(this.endpoint, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      }, this.sessionId);
      await this.listTools();
      this.ready = true;
    })();
    try {
      await this.connecting;
    } catch (error) {
      this.connecting = null;
      this.sessionId = null;
      throw error;
    }
  }

  async listTools() {
    const { message } = await rpc(this.endpoint, {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list'
    }, this.sessionId);
    this.tools = message?.result?.tools || [];
    return this.tools;
  }

  getTool(name) {
    return this.tools?.find(tool => tool.name === name);
  }

  reset() {
    this.ready = false;
    this.sessionId = null;
    this.connecting = null;
  }

  async callTool(name, args = {}) {
    await this.connect();
    const { message } = await rpc(this.endpoint, {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    }, this.sessionId);
    const result = message?.result;
    if (result?.isError) {
      throw new Error(result.content?.find(part => part.type === 'text')?.text || 'Search failed');
    }
    return (result?.content || [])
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('\n\n');
  }
}

module.exports = { ExaMcpClient };
