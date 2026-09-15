const SEPARATOR = /^\s*---\s*$/;
const FIELD_PREFIXES = [
  ['title', 'Title:'],
  ['url', 'URL:'],
  ['published', 'Published:'],
  ['author', 'Author:']
];

/**
 * Exa's MCP result is a compact textual wire format. Parsing it here keeps the
 * model prompt readable while also giving the browser structured source cards.
 */
function parseSearchResults(text) {
  if (!text) return [];
  const chunks = String(text).split(/\r?\n/).reduce((all, line) => {
    if (SEPARATOR.test(line)) {
      if (all.buffer.length) all.results.push(all.buffer.join('\n'));
      all.buffer = [];
    } else {
      all.buffer.push(line);
    }
    return all;
  }, { buffer: [], results: [] });

  if (chunks.buffer.length) chunks.results.push(chunks.buffer.join('\n'));
  return chunks.results.map(parseChunk).filter(Boolean).slice(0, 8);
}

module.exports = { parseSearchResults };

function parseChunk(chunk) {
  const fields = {};
  const highlights = [];
  let inHighlights = false;

  for (const line of chunk.split(/\r?\n/)) {
    if (!inHighlights && line.trim() === 'Highlights:') {
      inHighlights = true;
      continue;
    }
    if (inHighlights) {
      highlights.push(line);
      continue;
    }
    for (const [key, prefix] of FIELD_PREFIXES) {
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        if (value && value !== 'N/A') fields[key] = value;
        break;
      }
    }
  }

  if (!fields.title || !fields.url || !/^https?:\/\//i.test(fields.url)) return null;
  const result = { title: fields.title, url: fields.url };
  if (fields.published) result.published = fields.published;
  if (fields.author) result.author = fields.author;
  if (highlights.join('\n').trim()) result.highlights = highlights.join('\n').trim();
  return result;
}
