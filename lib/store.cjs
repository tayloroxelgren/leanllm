const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class ConversationStore {
  constructor(file) {
    this.file = file;
    this.data = { conversations: [] };
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = { conversations: [] };
    }
    this.data.conversations ||= [];
    this.loaded = true;
    return this.data;
  }

  save() {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(this.data, null, 2));
      await fs.rename(temp, this.file);
    }).catch(error => console.error('Unable to save conversations:', error));
    return this.writeQueue;
  }

  list() {
    return this.data.conversations.map(({ messages, ...summary }) => ({
      ...summary,
      messageCount: messages.length
    })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  get(id) {
    return this.data.conversations.find(item => item.id === id);
  }

  create({ model, webSearch = false }) {
    const now = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(),
      title: 'New chat',
      model,
      webSearch,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.data.conversations.push(conversation);
    this.save();
    return conversation;
  }

  update(id, patch) {
    const conversation = this.get(id);
    if (!conversation) return null;
    const allowed = ['title', 'model', 'webSearch'];
    for (const key of allowed) {
      if (patch[key] !== undefined) conversation[key] = patch[key];
    }
    conversation.updatedAt = new Date().toISOString();
    this.save();
    return conversation;
  }

  remove(id) {
    const before = this.data.conversations.length;
    this.data.conversations = this.data.conversations.filter(item => item.id !== id);
    this.save();
    return this.data.conversations.length < before;
  }

  addMessage(id, message) {
    const conversation = this.get(id);
    if (!conversation) return null;
    const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...message };
    conversation.messages.push(item);
    conversation.updatedAt = item.createdAt;
    if (conversation.title === 'New chat' && message.role === 'user' && message.content) {
      const clean = message.content.replace(/\s+/g, ' ').trim();
      conversation.title = clean.length > 58 ? `${clean.slice(0, 57)}…` : clean || 'New chat';
    }
    this.save();
    return item;
  }

  updateMessage(id, messageId, patch) {
    const conversation = this.get(id);
    const message = conversation?.messages.find(item => item.id === messageId);
    if (!message) return null;
    Object.assign(message, patch);
    this.save();
    return message;
  }
}

module.exports = { ConversationStore };
