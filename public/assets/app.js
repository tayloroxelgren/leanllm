(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = {
    conversations: [],
    conversation: null,
    models: [],
    model: localStorage.getItem('leanllm.model') || '',
    webSearch: localStorage.getItem('leanllm.webSearch') === '1',
    sending: false,
    controller: null,
    filter: ''
  };

  const settings = {
    ollamaUrl: localStorage.getItem('leanllm.ollamaUrl') || '',
    systemPrompt: localStorage.getItem('leanllm.systemPrompt') || '',
    temperature: localStorage.getItem('leanllm.temperature') || '0.7',
    topP: localStorage.getItem('leanllm.topP') || '0.9'
  };

  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendButton = $('send');
  const stopButton = $('stop');
  const toastEl = $('toast');

  async function api(pathname, options = {}) {
    const response = await fetch(pathname, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers
    });
    if (!response.ok) {
      let message = response.statusText;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => toastEl.classList.remove('show'), 4200);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function inlineMarkdown(text) {
    let value = escapeHtml(text);
    const codes = [];
    value = value.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(`<code>${code}</code>`);
      return `\u0000CODE${codes.length - 1}\u0000`;
    });
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    value = value.replace(/(^|[\s(])\*(?!\s)([^*\n]+)(?<!\s)\*(?=[\s).,!?:;]|$)/g, '$1<strong>$2</strong>');
    value = value.replace(/(^|[\s(])_(?!\s)([^_\n]+)(?<!\s)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    return value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codes[index]);
  }

  function renderMarkdown(raw = '') {
    const text = String(raw).replace(/\r\n?/g, '\n');
    const blocks = [];
    let work = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_, language, code) => {
      const lang = language.trim().split(/\s+/)[0] || 'text';
      blocks.push(`
        <div class="code-block">
          <button class="code-copy" type="button">Copy</button>
          <pre><code data-language="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>
        </div>`);
      return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });

    const paragraphs = [];
    let list = null;
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        paragraphs.push(`<p>${inlineMarkdown(paragraph.join('<br>'))}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        paragraphs.push(`<${list.tag}>${list.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</${list.tag}>`);
        list = null;
      }
    };

    for (const line of work.split('\n')) {
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);

      if (block) {
        flushParagraph(); flushList();
        paragraphs.push(blocks[Number(block[1])]);
      } else if (heading) {
        flushParagraph(); flushList();
        paragraphs.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      } else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushParagraph(); flushList();
        paragraphs.push('<hr>');
      } else if (line.trimStart().startsWith('>')) {
        flushParagraph(); flushList();
        paragraphs.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      } else if (bullet || ordered) {
        flushParagraph();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || ordered)[1]);
      } else if (!line.trim()) {
        flushParagraph(); flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph(); flushList();
    return paragraphs.join('');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function modelDisplayName(model) {
    return model ? model.split(':').slice(0, 2).join(':') : '';
  }

  function searchCard(message, live = false) {
    const complete = message.state === 'complete';
    const results = message.results || [];
    return `
      <details class="search-card" data-id="${message.id || ''}" data-state-key="resultsOpen" ${message.resultsOpen ? 'open' : ''}>
        <summary class="search-header">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>
          <span class="search-query">Searching: ${escapeHtml(message.query || '')}</span>
          <span class="search-state">${complete ? `${results.length} sources${message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}` : live ? 'Running…' : message.state === 'error' ? 'Failed' : 'Searching…'}</span>
          <svg class="summary-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        ${message.state === 'error' ? `<div class="search-error">${escapeHtml(message.error || 'Search failed')}</div>` : results.length ? `
          <div class="search-results">
            ${results.map(result => `
              <a class="search-result" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">
                <div class="result-title">${escapeHtml(result.title)}</div>
                <div class="result-url">${escapeHtml(result.url)}</div>
                ${result.highlights ? `<div class="result-highlight">${escapeHtml(result.highlights)}</div>` : ''}
              </a>`).join('')}
          </div>` : ''}
      </details>`;
  }

  function fetchCard(message) {
    const count = (message.urls || []).length;
    const label = message.state === 'complete'
      ? `${message.charCount || 0} chars${message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}`
      : message.state === 'running' ? 'Reading…' : 'Failed';
    return `
      <details class="search-card" data-id="${message.id || ''}" data-state-key="resultsOpen" ${message.resultsOpen ? 'open' : ''}>
        <summary class="search-header">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
          <span class="search-query">Reading ${count} page${count === 1 ? '' : 's'}</span>
          <span class="search-state">${label}</span>
          <svg class="summary-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        ${message.state === 'error' ? `<div class="search-error">${escapeHtml(message.error || 'Fetch failed')}</div>` : `
          <div class="search-results">
            ${(message.urls || []).map(url => `
              <a class="search-result" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
                <div class="result-title">${escapeHtml(url)}</div>
                <div class="result-url">Full page content used as model context</div>
              </a>`).join('')}
          </div>`}
      </details>`;
  }

  function messageNode(message, latestAssistant = false) {
    const element = document.createElement('div');
    if (message.role === 'user') {
      element.className = 'message message-user';
      element.innerHTML = `<div class="message-bubble">${escapeHtml(message.content)}</div>`;
      return element;
    }
    if (message.role === 'search') {
      element.className = 'message message-assistant';
      element.innerHTML = searchCard(message);
      return element;
    }
    if (message.role === 'fetch') {
      element.className = 'message message-assistant';
      element.innerHTML = fetchCard(message);
      return element;
    }

    element.className = 'message message-assistant';
    const hasThinking = Boolean(message.thinking);
    const thinkingOpen = message.thinkingOpen === true;
    const thinkingBlock = hasThinking ? `
      <details class="thinking-block" data-state-key="thinkingOpen" ${thinkingOpen ? 'open' : ''}>
        <summary>
          <svg viewBox="0 0 24 24"><path d="M12 5a4 4 0 0 0-4 4c-2 .5-3 2-3 3.5S6.5 16 8 16v3h8v-3c1.5 0 3-1 3-3.5S18 9.5 16 9a4 4 0 0 0-4-4Z"/><path d="M9 22h6"/></svg>
          <span>${message.streaming && !message.content ? 'Thinking…' : 'Thinking'}</span>
          <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <div class="thinking-content">${escapeHtml(message.thinking)}</div>
      </details>` : '';
    const loading = message.streaming && !message.content && !hasThinking && !(message.toolCalls || []).length;
    element.innerHTML = `
      ${thinkingBlock}
      <div class="markdown">${loading ? '<div class="thinking">Thinking</div>' : renderMarkdown(message.content || '')}</div>
      ${message.streaming && message.content && latestAssistant ? '<span class="cursor"></span>' : ''}
      ${message.error ? `<div class="connection-banner">${escapeHtml(message.error)}</div>` : ''}
      <div class="message-actions"><button class="conversation-action" data-copy-message title="Copy message"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
    `;
    for (const details of element.querySelectorAll('details[data-state-key]')) {
      details.addEventListener('toggle', () => {
        message[details.dataset.stateKey] = details.open;
      });
    }
    return element;
  }

  function renderConversation() {
    messagesEl.replaceChildren();
    const conversation = state.conversation;
    if (!conversation?.messages?.length) {
      messagesEl.appendChild($('welcome-template').content.cloneNode(true));
      return;
    }
    const lastAssistant = [...conversation.messages].reverse().find(message => message.role === 'assistant');
    for (const message of conversation.messages) {
      messagesEl.appendChild(messageNode(message, message === lastAssistant));
    }
    scrollToBottom(true);
  }

  function setAssistantNode(node) {
    const previous = assistantNodeRef.current;
    const last = messagesEl.lastElementChild;
    if (!previous) {
      messagesEl.appendChild(node);
    } else if (last && last !== previous) {
      last.after(node);
      previous.remove();
    } else {
      previous.replaceWith(node);
    }
    assistantNodeRef.current = node;
  }

  function preserveOpenSections() {
    const openState = new Map();
    const assistant = [...state.conversation?.messages || []].reverse().find(message => message.role === 'assistant');
    const liveThinking = assistantNodeRef.current?.querySelector('.thinking-block');
    if (assistant && liveThinking) openState.set(assistant.id, { thinkingOpen: liveThinking.open });

    for (const details of messagesEl.querySelectorAll('.search-card[data-id]')) {
      const message = state.conversation?.messages.find(item => item.id === details.dataset.id);
      if (message) openState.set(message.id, { resultsOpen: details.open });
    }
    return openState;
  }

  function renderConversationList() {
    const list = $('conversation-list');
    const query = state.filter.trim().toLowerCase();
    const visible = state.conversations.filter(item => !query || item.title.toLowerCase().includes(query));
    list.innerHTML = visible.length ? '' : '<div class="list-empty">No chats found</div>';
    for (const item of visible) {
      const button = document.createElement('div');
      button.className = `conversation-item${item.id === state.conversation?.id ? ' active' : ''}`;
      button.setAttribute('role', 'button');
      button.tabIndex = 0;
      button.dataset.id = item.id;
      button.innerHTML = `
        <span class="conversation-title">${escapeHtml(item.title)}</span>
        <span class="conversation-actions">
          <button class="conversation-action rename" title="Rename"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button class="conversation-action delete" title="Delete"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6"/></svg></button>
        </span>`;
      list.appendChild(button);
    }
  }

  function renderModels() {
    const query = ($('model-filter').value || '').toLowerCase();
    const list = $('model-list');
    const visible = state.models.filter(model => model.name.toLowerCase().includes(query));
    list.innerHTML = '';
    if (!visible.length) {
      list.innerHTML = '<div class="model-empty">No Ollama models found</div>';
      return;
    }
    for (const model of visible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-option${model.name === state.model ? ' selected' : ''}`;
      button.dataset.model = model.name;
      button.innerHTML = `
        <div class="model-option-name">${escapeHtml(model.name)}</div>
        <div class="model-option-meta">
          ${model.parameterSize ? `<span>${escapeHtml(model.parameterSize)}</span>` : ''}
          ${model.quantization ? `<span>${escapeHtml(model.quantization)}</span>` : ''}
          ${model.contextLength ? `<span>${Math.round(model.contextLength / 1024)}k ctx</span>` : ''}
          ${(model.capabilities || []).filter(capability => ['tools', 'vision', 'thinking'].includes(capability)).map(capability => `<span>${escapeHtml(capability)}</span>`).join('')}
          ${model.size ? `<span>${formatBytes(model.size)}</span>` : ''}
        </div>`;
      list.appendChild(button);
    }
  }

  function setModel(name) {
    state.model = name;
    localStorage.setItem('leanllm.model', name || '');
    $('model-name').textContent = name ? modelDisplayName(name) : 'Select model';
    $('composer-model-name').textContent = name ? modelDisplayName(name) : 'Model';
    $('model-name').previousElementSibling.dataset.state = name ? 'ready' : 'unknown';
    renderModels();
  }

  function setWebSearch(enabled) {
    state.webSearch = Boolean(enabled);
    localStorage.setItem('leanllm.webSearch', state.webSearch ? '1' : '0');
    $('web-search-toggle').setAttribute('aria-pressed', String(state.webSearch));
    $('composer-search').setAttribute('aria-pressed', String(state.webSearch));
  }

  function closeMenus() {
    $('model-menu').hidden = true;
    $('model-trigger').setAttribute('aria-expanded', 'false');
  }

  function scrollToBottom(instant = false) {
    const options = { top: messagesEl.scrollHeight };
    if (instant) options.behavior = 'instant';
    messagesEl.scrollTo(options);
  }

  async function loadModels() {
    $('model-name').previousElementSibling.dataset.state = 'unknown';
    try {
      const query = settings.ollamaUrl ? `?ollamaUrl=${encodeURIComponent(settings.ollamaUrl)}` : '';
      const data = await api(`/api/models${query}`);
      state.models = data.models || [];
      const preferred = () => state.models.find(model => model.capabilities?.includes('tools')) || state.models[0];
      if (!state.model && state.models.length) setModel(preferred().name);
      if (state.model && !state.models.some(model => model.name === state.model)) setModel(preferred()?.name || '');
      renderModels();
    } catch (error) {
      state.models = [];
      renderModels();
      showConnectionError(`Ollama is unavailable: ${error.message}`);
    }
  }

  function showConnectionError(message) {
    const banner = $('connection-banner');
    banner.textContent = message;
    banner.hidden = false;
  }

  function clearConnectionError() {
    $('connection-banner').hidden = true;
  }

  async function loadConversations() {
    const data = await api('/api/conversations');
    state.conversations = data.conversations || [];
    renderConversationList();
  }

  async function openConversation(id) {
    if (state.sending) stopSending();
    const conversation = await api(`/api/conversations/${id}`);
    state.conversation = conversation;
    setModel(conversation.model || state.model);
    setWebSearch(Boolean(conversation.webSearch));
    renderConversation();
    renderConversationList();
  }

  function newChat() {
    if (state.sending) stopSending();
    state.conversation = null;
    renderConversation();
    renderConversationList();
    inputEl.focus();
  }

  function updateInputState() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 192)}px`;
    sendButton.disabled = state.sending || !inputEl.value.trim();
  }

  function stopSending() {
    state.controller?.abort();
  }

  async function appendEvent(kind, payload = {}) {
    const conversation = state.conversation;
    if (!conversation) return null;
    let message;
    if (payload.id) message = conversation.messages.find(item => item.id === payload.id);
    if (!message && kind === 'search-created') {
      message = { id: payload.id, role: 'search', query: payload.query, results: [], state: 'running' };
      conversation.messages.push(message);
    }
    if (!message && kind === 'fetch-created') {
      message = { id: payload.id, role: 'fetch', urls: payload.urls || [], state: 'running' };
      conversation.messages.push(message);
    }
    return message;
  }

  async function sendMessage() {
    const content = inputEl.value.trim();
    if (!content || state.sending) return;
    if (!state.model) { toast('Select an Ollama model first'); return; }
    clearConnectionError();
    state.sending = true;
    state.controller = new AbortController();
    sendButton.disabled = true;
    stopButton.hidden = false;
    inputEl.value = '';
    updateInputState();
    if (!state.conversation) {
      state.conversation = { id: null, messages: [], title: 'New chat' };
      messagesEl.replaceChildren();
    } else {
      state.conversation.messages.push({ id: `local-user-${Date.now()}`, role: 'user', content });
      messagesEl.appendChild(messageNode(state.conversation.messages.at(-1)));
      scrollToBottom();
    }

    const localAssistant = { id: `local-assistant-${Date.now()}`, role: 'assistant', content: '', streaming: true };
    state.conversation.messages.push(localAssistant);
    let assistantNode = messageNode(localAssistant, true);
    messagesEl.appendChild(assistantNode);
    scrollToBottom();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: state.controller.signal,
        body: JSON.stringify({
          conversationId: state.conversation.id,
          model: state.model,
          webSearch: state.webSearch,
          message: content,
          ollamaUrl: settings.ollamaUrl,
          systemPrompt: settings.systemPrompt,
          temperature: Number(settings.temperature),
          topP: Number(settings.topP)
        })
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          await handleChatEvent(event, localAssistant);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        localAssistant.error = error.message;
        showConnectionError(error.message);
      }
      localAssistant.streaming = false;
      setAssistantNode(messageNode(localAssistant, false));
    } finally {
      state.sending = false;
      state.controller = null;
      stopButton.hidden = true;
      updateInputState();
      const openState = preserveOpenSections();
      await loadConversations();
      if (state.conversation?.id) {
        const saved = await api(`/api/conversations/${state.conversation.id}`);
        for (const message of saved.messages || []) {
          const open = openState.get(message.id);
          if (open) {
            message.thinkingOpen = open.thinkingOpen === true;
            message.resultsOpen = open.resultsOpen === true;
          }
        }
        state.conversation = saved;
        renderConversation();
      }
    }
  }

  async function handleChatEvent(event, localAssistant) {
    const conversation = state.conversation;
    if (event.type === 'start') {
      conversation.id = event.conversation.id;
      conversation.messages = [event.user];
      renderConversation();
      const node = messageNode(localAssistant, true);
      messagesEl.appendChild(node);
      assistantNodeRef.current = node;
      scrollToBottom();
      return;
    }

    if (event.type === 'assistant-created') {
      const existing = conversation.messages.find(item => item.id === event.id);
      if (!existing) conversation.messages.push({ id: event.id, role: 'assistant', content: '', streaming: true, searches: [] });
      const target = conversation.messages.at(-1);
      target.id = event.id;
      target.thinking ||= '';
      target.thinkingOpen = false;
      localAssistant.id = event.id;
      localAssistant.thinking = target.thinking;
      localAssistant.thinkingOpen = false;
      const node = messageNode(target, true);
      setAssistantNode(node);
      scrollToBottom();
      return;
    }

    if (event.type === 'delta') {
      const message = await appendEvent('delta', event);
      if (!message) return;
      message.thinkingOpen = assistantNodeRef.current?.querySelector('.thinking-block')?.open === true;
      const thinkingScroll = assistantNodeRef.current?.querySelector('.thinking-content')?.scrollTop || 0;
      message.content = (message.content || '') + event.content;
      Object.assign(localAssistant, message);
      const node = messageNode(message, true);
      setAssistantNode(node);
      const thinkingContent = node.querySelector('.thinking-content');
      if (thinkingContent) thinkingContent.scrollTop = thinkingScroll;
      if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160) scrollToBottom();
      return;
    }

    if (event.type === 'thinking') {
      const message = await appendEvent('thinking', event);
      if (!message) return;
      message.thinking = (message.thinking || '') + event.content;
      const existingDetails = assistantNodeRef.current?.querySelector('.thinking-block');
      message.thinkingOpen = existingDetails?.open === true;
      Object.assign(localAssistant, message);
      if (!existingDetails) {
        setAssistantNode(messageNode(message, true));
      } else {
        const label = existingDetails.querySelector('summary span');
        const content = existingDetails.querySelector('.thinking-content');
        if (label) label.textContent = 'Thinking…';
        if (content) {
          content.textContent = message.thinking;
          if (existingDetails.open) content.scrollTop = content.scrollHeight;
        }
      }
      if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 200) scrollToBottom();
      return;
    }

    if (event.type === 'search-created') {
      const message = await appendEvent('search-created', event);
      message.resultsOpen = false;
      messagesEl.appendChild(messageNode(message));
      scrollToBottom();
      return;
    }

    if (event.type === 'fetch-created') {
      const message = await appendEvent('fetch-created', event);
      message.resultsOpen = false;
      messagesEl.appendChild(messageNode(message));
      scrollToBottom();
      return;
    }

    if (event.type === 'fetch') {
      const message = conversation.messages.find(item => item.role === 'fetch' && item.state === 'running')
        || await appendEvent('fetch', event);
      if (!message) return;
      message.state = event.state;
      if (event.urls) message.urls = event.urls;
      if (event.charCount) message.charCount = event.charCount;
      if (event.durationMs) message.durationMs = event.durationMs;
      if (event.error) message.error = event.error;
      const existing = messagesEl.querySelector(`.search-card[data-id="${message.id}"]`);
      const isOpen = existing?.open === true;
      message.resultsOpen = isOpen;
      const node = messageNode(message);
      node.querySelector('.search-card').open = isOpen;
      existing?.closest('.message')?.replaceWith(node);
      scrollToBottom();
      return;
    }

    if (event.type === 'search') {
      const message = conversation.messages.find(item => item.role === 'search' && item.query === event.query && item.state === 'running')
        || await appendEvent('search', event);
      if (!message) return;
      message.state = event.state;
      if (event.results) message.results = event.results;
      if (event.error) message.error = event.error;
      if (event.durationMs) message.durationMs = event.durationMs;
      const saved = conversation.messages.find(item => item.id === message.id);
      if (saved) Object.assign(saved, message);
      const existing = messagesEl.querySelector(`.search-card[data-id="${message.id}"]`);
      const isOpen = existing?.open === true;
      message.resultsOpen = isOpen;
      const node = messageNode(message);
      node.querySelector('.search-card').open = isOpen;
      existing?.closest('.message')?.replaceWith(node);
      scrollToBottom();
      return;
    }

    if (event.type === 'error') {
      const message = conversation.messages.find(item => item.id === event.id) || localAssistant;
      message.streaming = false;
      message.error = event.error;
      const node = messageNode(message, false);
      setAssistantNode(node);
    }
  }

  const assistantNodeRef = { current: null };

  function applySettingsFromForm() {
    settings.ollamaUrl = $('ollama-url').value.trim();
    settings.systemPrompt = $('system-prompt').value;
    settings.temperature = $('temperature').value;
    settings.topP = $('top-p').value;
    localStorage.setItem('leanllm.ollamaUrl', settings.ollamaUrl);
    localStorage.setItem('leanllm.systemPrompt', settings.systemPrompt);
    localStorage.setItem('leanllm.temperature', settings.temperature);
    localStorage.setItem('leanllm.topP', settings.topP);
    $('temperature-output').textContent = Number(settings.temperature).toFixed(2);
    $('top-p-output').textContent = Number(settings.topP).toFixed(2);
    loadModels();
  }

  function setTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('leanllm.theme', dark ? 'dark' : 'light');
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
  }

  document.addEventListener('click', async event => {
    const copyButton = event.target.closest('.code-copy');
    if (copyButton) {
      const code = copyButton.parentElement.querySelector('code')?.textContent || '';
      await navigator.clipboard.writeText(code);
      copyButton.textContent = 'Copied';
      setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200);
      return;
    }
    const copyMessage = event.target.closest('[data-copy-message]');
    if (copyMessage) {
      const text = copyMessage.closest('.message')?.querySelector('.markdown')?.textContent || '';
      await navigator.clipboard.writeText(text);
      toast('Message copied');
      return;
    }

    const item = event.target.closest('.conversation-item');
    if (item && !event.target.closest('.conversation-action')) {
      try { await openConversation(item.dataset.id); } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.closest('.conversation-action.delete')) {
      const id = event.target.closest('.conversation-item').dataset.id;
      await api(`/api/conversations/${id}`, { method: 'DELETE' });
      if (state.conversation?.id === id) newChat();
      await loadConversations();
      toast('Chat deleted');
      return;
    }
    if (event.target.closest('.conversation-action.rename')) {
      const id = event.target.closest('.conversation-item').dataset.id;
      const current = state.conversations.find(entry => entry.id === id);
      const title = prompt('Rename chat', current?.title || '');
      if (title?.trim()) {
        await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
        await loadConversations();
        if (state.conversation?.id === id) state.conversation.title = title.trim();
      }
      return;
    }

    const modelButton = event.target.closest('.model-option');
    if (modelButton) {
      setModel(modelButton.dataset.model);
      closeMenus();
      return;
    }
    if (!event.target.closest('#model-menu') && !event.target.closest('#model-trigger') && !event.target.closest('#composer-model')) closeMenus();
  });
  document.addEventListener('keydown', async event => {
    if ((event.key !== 'Enter' && event.key !== ' ') || !event.target.classList?.contains('conversation-item')) return;
    event.preventDefault();
    try { await openConversation(event.target.dataset.id); } catch (error) { toast(error.message); }
  });

  $('model-trigger').addEventListener('click', () => {
    const menu = $('model-menu');
    const open = menu.hidden;
    menu.hidden = !open;
    $('model-trigger').setAttribute('aria-expanded', String(open));
    if (open) { renderModels(); $('model-filter').focus(); }
  });
  $('composer-model').addEventListener('click', () => {
    $('model-trigger').click();
    $('model-trigger').scrollIntoView({ block: 'nearest' });
  });
  $('model-filter').addEventListener('input', renderModels);

  $('composer').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
  stopButton.addEventListener('click', stopSending);
  inputEl.addEventListener('input', updateInputState);
  inputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  $('web-search-toggle').addEventListener('click', () => setWebSearch(!state.webSearch));
  $('composer-search').addEventListener('click', () => setWebSearch(!state.webSearch));
  $('new-chat').addEventListener('click', newChat);
  $('new-chat-desktop').addEventListener('click', newChat);
  $('conversation-filter').addEventListener('input', event => {
    state.filter = event.target.value;
    renderConversationList();
  });
  $('open-sidebar').addEventListener('click', () => {
    $('sidebar').classList.add('open');
    $('sidebar-backdrop').classList.add('open');
  });
  const closeSidebar = () => {
    $('sidebar').classList.remove('open');
    $('sidebar-backdrop').classList.remove('open');
  };
  $('close-sidebar').addEventListener('click', closeSidebar);
  $('sidebar-backdrop').addEventListener('click', closeSidebar);
  $('open-settings').addEventListener('click', () => $('settings').showModal());
  $('settings').addEventListener('close', applySettingsFromForm);
  $('settings').addEventListener('click', event => { if (event.target === $('settings')) $('settings').close(); });
  $('temperature').addEventListener('input', event => { $('temperature-output').textContent = Number(event.target.value).toFixed(2); });
  $('top-p').addEventListener('input', event => { $('top-p-output').textContent = Number(event.target.value).toFixed(2); });
  $('theme-toggle').addEventListener('click', () => setTheme(!document.documentElement.classList.contains('dark')));
  $('scroll-down').addEventListener('click', () => scrollToBottom());
  messagesEl.addEventListener('scroll', () => {
    $('scroll-down').hidden = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  });
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('conversation-filter').focus();
    }
  });

  setTheme(document.documentElement.classList.contains('dark'));
  setWebSearch(state.webSearch);
  $('ollama-url').value = settings.ollamaUrl;
  $('system-prompt').value = settings.systemPrompt;
  $('temperature').value = settings.temperature;
  $('top-p').value = settings.topP;
  $('temperature-output').textContent = Number(settings.temperature).toFixed(2);
  $('top-p-output').textContent = Number(settings.topP).toFixed(2);
  updateInputState();
  renderConversation();
  loadModels();
  loadConversations().catch(error => toast(error.message));
})();
