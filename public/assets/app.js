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
  const attachments = [];
  const maxImages = 4;

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
  const imageInput = $('image-input');
  const imagePreviews = $('image-previews');
  const imageButton = $('composer-image');
  const messageSources = new WeakMap();
  let autoFollow = true;
  let previousScrollTop = 0;

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

  const renderMarkdown = raw => LeanMarkdown.render(raw);

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function currentModel() {
    return state.models.find(model => model.name === state.model);
  }

  function currentModelSupportsVision() {
    return currentModel()?.capabilities?.includes('vision') === true;
  }

  function clearAttachments() {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    attachments.splice(0, attachments.length);
    renderAttachments();
  }

  function removeAttachment(id) {
    const index = attachments.findIndex(attachment => attachment.id === id);
    if (index === -1) return;
    URL.revokeObjectURL(attachments[index].previewUrl);
    attachments.splice(index, 1);
    renderAttachments();
  }

  function renderAttachments() {
    imagePreviews.replaceChildren();
    imagePreviews.hidden = !attachments.length;
    for (const attachment of attachments) {
      const figure = document.createElement('figure');
      figure.className = 'image-preview';
      figure.innerHTML = `
        <img src="${escapeHtml(attachment.previewUrl)}" alt="${escapeHtml(attachment.file.name)}">
        <button type="button" class="image-preview-remove" data-id="${escapeHtml(attachment.id)}" title="Remove image" aria-label="Remove ${escapeHtml(attachment.file.name)}">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>`;
      imagePreviews.appendChild(figure);
    }
    updateInputState();
  }

  async function fileToAttachment(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) throw new Error('Images must be JPEG, PNG, or WebP');
    if (file.size > 20 * 1024 * 1024) throw new Error('Images must be 20 MB or smaller');

    const id = `image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let output = file;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const maxSize = 1568;
      const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
      if (scale < 1 || file.type !== 'image/jpeg') {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        output = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
        if (!output) throw new Error('Unable to prepare image');
      }
      bitmap.close();
    } catch {
      // Browser decoders can reject formats even when the file selector allows them.
      if (!allowed.includes(file.type)) throw new Error(`${file.name} could not be decoded`);
    }

    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
      reader.readAsDataURL(output);
    });
    return { id, file, data, previewUrl: URL.createObjectURL(output) };
  }

  async function addFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (!currentModelSupportsVision()) {
      toast(`${state.model || 'This model'} does not advertise vision support`);
      return;
    }
    const room = maxImages - attachments.length;
    if (room <= 0) { toast(`You can attach at most ${maxImages} images`); return; }
    if (list.length > room) toast(`Only the first ${room} image${room === 1 ? '' : 's'} were added`);

    for (const file of list.slice(0, room)) {
      try {
        attachments.push(await fileToAttachment(file));
      } catch (error) {
        toast(error.message);
      }
    }
    renderAttachments();
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
    messageSources.set(element, message.content || '');
    if (message.role === 'user') {
      element.className = 'message message-user';
      const images = message.images || [];
      element.innerHTML = `
        <div class="message-bubble">
          ${images.length ? `<div class="message-images">${images.map(image => `
            <img src="${escapeHtml(image)}" alt="Attached image" loading="lazy">`).join('')}</div>` : ''}
          ${message.content ? `<div>${escapeHtml(message.content)}</div>` : ''}
        </div>`;
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

      const content = details.querySelector('.thinking-content');
      if (content) {
        content.dataset.sticky = 'true';
        content.addEventListener('scroll', () => {
          content.dataset.sticky =
            content.scrollHeight - content.scrollTop - content.clientHeight < 80 ? 'true' : 'false';
        }, { passive: true });
      }
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
    const supportsVision = state.models.find(model => model.name === name)?.capabilities?.includes('vision') === true;
    state.model = name;
    localStorage.setItem('leanllm.model', name || '');
    $('model-name').textContent = name ? modelDisplayName(name) : 'Select model';
    $('composer-model-name').textContent = name ? modelDisplayName(name) : 'Model';
    $('model-name').previousElementSibling.dataset.state = name ? 'ready' : 'unknown';
    imageButton.disabled = !supportsVision;
    if (!supportsVision && attachments.length) {
      clearAttachments();
      toast(`${name ? `${modelDisplayName(name)} does not advertise vision support` : 'Select a model to attach images'}`);
    }
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
    autoFollow = true;
    const options = { top: messagesEl.scrollHeight, behavior: 'instant' };
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
      imageButton.disabled = true;
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
    clearAttachments();
    const conversation = await api(`/api/conversations/${id}`);
    state.conversation = conversation;
    setModel(conversation.model || state.model);
    setWebSearch(Boolean(conversation.webSearch));
    renderConversation();
    renderConversationList();
  }

  function newChat() {
    if (state.sending) stopSending();
    clearAttachments();
    state.conversation = null;
    renderConversation();
    renderConversationList();
    inputEl.focus();
  }

  function updateInputState() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 192)}px`;
    sendButton.disabled = state.sending || (!inputEl.value.trim() && !attachments.length);
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
    if ((!content && !attachments.length) || state.sending) return;
    if (!state.model) { toast('Select an Ollama model first'); return; }
    clearConnectionError();
    state.sending = true;
    state.controller = new AbortController();
    sendButton.disabled = true;
    stopButton.hidden = false;
    inputEl.value = '';
    updateInputState();
    const images = attachments.map(attachment => attachment.data);
    if (!state.conversation) {
      state.conversation = { id: null, messages: [], title: 'New chat' };
      messagesEl.replaceChildren();
    } else {
      state.conversation.messages.push({
        id: `local-user-${Date.now()}`,
        role: 'user',
        content,
        ...(images.length ? { images } : {})
      });
      messagesEl.appendChild(messageNode(state.conversation.messages.at(-1)));
      if (autoFollow) scrollToBottom();
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
          images,
          ollamaUrl: settings.ollamaUrl,
          systemPrompt: settings.systemPrompt,
          temperature: Number(settings.temperature),
          topP: Number(settings.topP)
        })
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
      clearAttachments();

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
      if (autoFollow) scrollToBottom();
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
      const previousThinkingContent = assistantNodeRef.current?.querySelector('.thinking-content');
      message.thinkingOpen = Boolean(previousThinkingContent?.closest('.thinking-block')?.open);
      const thinkingScroll = previousThinkingContent?.scrollTop || 0;
      const thinkingSticky = previousThinkingContent?.dataset.sticky !== 'false';
      message.content = (message.content || '') + event.content;
      Object.assign(localAssistant, message);
      const node = messageNode(message, true);
      setAssistantNode(node);
      const thinkingContent = node.querySelector('.thinking-content');
      if (thinkingContent) {
        thinkingContent.dataset.sticky = String(thinkingSticky);
        thinkingContent.scrollTop = thinkingScroll;
      }
      if (autoFollow) scrollToBottom();
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
          const sticky = content.dataset.sticky !== 'false';
          const scrollTop = content.scrollTop;
          content.textContent = message.thinking;
          if (existingDetails.open) content.scrollTop = sticky ? content.scrollHeight : scrollTop;
        }
      }
      if (autoFollow) scrollToBottom();
      return;
    }

    if (event.type === 'search-created') {
      const message = await appendEvent('search-created', event);
      message.resultsOpen = false;
      messagesEl.appendChild(messageNode(message));
      if (autoFollow) scrollToBottom();
      return;
    }

    if (event.type === 'fetch-created') {
      const message = await appendEvent('fetch-created', event);
      message.resultsOpen = false;
      messagesEl.appendChild(messageNode(message));
      if (autoFollow) scrollToBottom();
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

  async function copyText(text) {
    if (!text) throw new Error('Nothing to copy');
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'copy-fallback';
    textarea.setAttribute('aria-hidden', 'true');
    document.body.appendChild(textarea);
    const selection = document.getSelection();
    const previousRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    try {
      if (!document.execCommand('copy')) throw new Error('Clipboard copy denied');
    } finally {
      textarea.remove();
      if (previousRange && selection) {
        selection.removeAllRanges();
        selection.addRange(previousRange);
      }
    }
  }

  function copyableCode(block) {
    const code = block.querySelector('code')?.textContent || '';
    if (!block.classList.contains('command-block')) return code;
    return code.split(/\r?\n/).map(line => {
      const prompt = line.match(/^\s*(?:\$|%|>|PS>\s?)(?:\s+)(.*)$/);
      return prompt ? prompt[1] : line;
    }).filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1)).join('\n');
  }

  document.addEventListener('click', async event => {
    const copyButton = event.target.closest('.code-copy');
    if (copyButton) {
      const original = copyButton.textContent;
      copyButton.textContent = 'Copying…';
      try {
        await copyText(copyableCode(copyButton.closest('.code-block')));
        copyButton.textContent = 'Copied';
      } catch (error) {
        copyButton.textContent = original;
        toast(error.message);
      } finally {
        setTimeout(() => { copyButton.textContent = original; }, 1200);
      }
      return;
    }
    const copyMessage = event.target.closest('[data-copy-message]');
    if (copyMessage) {
      try {
        await copyText(messageSources.get(copyMessage.closest('.message')) || '');
        toast('Message copied');
      } catch (error) {
        toast(error.message);
      }
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
  $('composer-image').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    addFiles(imageInput.files).catch(error => toast(error.message));
    imageInput.value = '';
  });
  imagePreviews.addEventListener('click', event => {
    const button = event.target.closest('.image-preview-remove');
    if (button) removeAttachment(button.dataset.id);
  });
  inputEl.addEventListener('paste', event => {
    if (event.clipboardData?.files?.length) {
      event.preventDefault();
      addFiles(event.clipboardData.files).catch(error => toast(error.message));
    }
  });
  $('composer').addEventListener('dragover', event => {
    event.preventDefault();
    $('composer').classList.add('drag-over');
  });
  $('composer').addEventListener('dragleave', event => {
    if (event.target.closest('#composer')) $('composer').classList.remove('drag-over');
  });
  $('composer').addEventListener('drop', event => {
    event.preventDefault();
    $('composer').classList.remove('drag-over');
    addFiles(event.dataTransfer?.files).catch(error => toast(error.message));
  });
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
    const scrollTop = messagesEl.scrollTop;
    const nearBottom = messagesEl.scrollHeight - scrollTop - messagesEl.clientHeight < 80;
    // Content growth can change the bottom margin without changing scrollTop. Treat an
    // explicit upward scroll as the user's request to stop following the stream.
    if (scrollTop < previousScrollTop - 1) autoFollow = false;
    else if (nearBottom) autoFollow = true;
    previousScrollTop = scrollTop;
    $('scroll-down').hidden = nearBottom;
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
