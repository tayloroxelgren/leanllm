#!/usr/bin/env node
// One-time migration: move inline base64 images from conversations.json into
// data/images/ so the store (and its RAM footprint) stays small. Run while the
// app is stopped. A timestamped backup is written before anything is replaced.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  const dataDir = process.env.LEANLLM_DATA_DIR || path.join(__dirname, '..', 'data');
  const storeFile = path.join(dataDir, 'conversations.json');
  const imagesDir = path.join(dataDir, 'images');
  const data = JSON.parse(await fsp.readFile(storeFile, 'utf8'));
  let converted = 0;
  let savedBytes = 0;

  for (const conversation of data.conversations || []) {
    for (const message of conversation.messages || []) {
      if (!Array.isArray(message.images)) continue;
      for (const [index, value] of message.images.entries()) {
        const match = String(value).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
        if (!match) continue;
        const decoded = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
        if (!decoded.length) continue;
        await fsp.mkdir(imagesDir, { recursive: true });
        const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1] === 'image/png' ? 'png' : 'webp';
        const name = `${crypto.randomUUID()}.${extension}`;
        await fsp.writeFile(path.join(imagesDir, name), decoded);
        message.images[index] = `/api/images/${name}`;
        converted += 1;
        savedBytes += value.length;
      }
    }
  }

  if (!converted) {
    console.log('No inline images found; store left unchanged.');
    return;
  }
  const backup = `${storeFile}.bak-${Date.now()}`;
  await fsp.copyFile(storeFile, backup);
  const temp = `${storeFile}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2));
  await fsp.rename(temp, storeFile);
  console.log(`Migrated ${converted} images; store content shrank by ~${Math.round(savedBytes / 1024)} KB. Backup: ${backup}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
