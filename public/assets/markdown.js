(() => {
  'use strict';

  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);

  const safeUrl = (url, allowImageData = false) => {
    const value = String(url).trim();
    if (/^\s*javascript:|^\s*vbscript:/i.test(value)) return '';
    if (allowImageData && /^\s*data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i.test(value)) return value;
    if (/^\s*data:/i.test(value)) return '';
    if (/^(https?:|mailto:|\/|#|\.\.?\/)/i.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value)) {
      return escapeHtml(value);
    }
    return '';
  };

  function renderInline(source) {
    const codes = [];
    let value = escapeHtml(source);

    value = value.replace(/(`+)([\s\S]*?)\1/g, (_, markers, code) => {
      codes.push(`<code>${code.replace(/^`|`$/g, '')}</code>`);
      return `\u0000LEANCODE:${codes.length - 1}:\u0000`;
    });

    value = value.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (_, alt, url, title) => {
        const href = safeUrl(url, true);
        return href ? `<img src="${href}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">` : alt;
      }
    );

    value = value.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (_, text, url, title) => {
        const href = safeUrl(url);
        return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${text}</a>` : text;
      }
    );

    value = value.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&;]+)&gt;/gi, (_, url) => {
      const href = safeUrl(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` : _;
    });

    value = value
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, '<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

    value = value.replace(/ {2,}\n/g, '<br>').replace(/\n/g, '<br>');
    return value.replace(/\u0000LEANCODE:(\d+):\u0000/g, (_, index) => codes[Number(index)]);
  }

  const isFence = line => /^\u0000LEANBLOCK:(\d+):\u0000$/.test(line);
  const isBlank = line => !line.trim();
  const heading = line => line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
  const rule = line => /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  const quote = line => line.match(/^\s{0,3}>\s?(.*)$/);
  const listItem = line => line.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/);

  const splitTableRow = row => row.trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'));

  const isTableDivider = line => {
    const cells = splitTableRow(line);
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  };

  function parseList(lines, startIndex) {
    const first = listItem(lines[startIndex]);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const startNumber = ordered ? Number(first[2].replace(/\D/g, '')) : 1;
    const items = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        const next = lines[index + 1] || '';
        const nextItem = listItem(next);
        const continuation = /^\s+\S/.test(next);
        if (!nextItem && !continuation) break;
        if (nextItem && nextItem[1].length < baseIndent) break;
        if (items.length) items.at(-1).push('');
        index += 1;
        continue;
      }

      const item = listItem(line);
      if (item) {
        const indent = item[1].length;
        if (indent < baseIndent) break;
        if (indent === baseIndent) {
          const sameKind = /\d/.test(item[2]) === ordered;
          if (!sameKind) break;
          items.push([item[3]]);
          index += 1;
          continue;
        }
      } else if (items.length === 0 || !/^\s+\S/.test(line)) {
        break;
      }

      if (!items.length) break;
      items.at(-1).push(line.slice(Math.min(line.match(/^\s*/)[0].length, baseIndent + 2)));
      index += 1;
    }

    while (items.length && !items.at(-1).some(value => value.trim())) items.pop();
    const html = items.map(item => {
      const content = item.join('\n');
      const simple = item.length === 1 && !isFence(item[0]) && !heading(item[0]) && !rule(item[0]);
      return `<li>${simple ? renderInline(content) : renderBlocks(content)}</li>`;
    }).join('');
    const tag = ordered ? 'ol' : 'ul';
    return {
      index,
      html: ordered && startNumber !== 1 ? `<${tag} start="${startNumber}">${html}</${tag}>` : `<${tag}>${html}</${tag}>`
    };
  }

  function parseTable(lines, startIndex) {
    const header = splitTableRow(lines[startIndex]);
    const divider = splitTableRow(lines[startIndex + 1]);
    const align = divider.map(cell => {
      if (/^:-+:$/.test(cell)) return ' style="text-align:center"';
      if (/:-$/.test(cell)) return ' style="text-align:right"';
      if (/^:-+$/.test(cell)) return ' style="text-align:left"';
      return '';
    });
    let index = startIndex + 2;
    const rows = [];
    while (index < lines.length && lines[index].trim() && !isTableDivider(lines[index]) && !heading(lines[index])) {
      rows.push(splitTableRow(lines[index]));
      index += 1;
    }

    const cell = (value, at) => `<td${align[at] || ''}>${renderInline(value)}</td>`;
    const head = `<tr>${header.map((value, at) => `<th${align[at] || ''}>${renderInline(value)}</th>`).join('')}</tr>`;
    const body = rows.map(row => `<tr>${header.map((_, at) => cell(row[at] || '', at)).join('')}</tr>`).join('');
    return { index, html: `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>` };
  }

  function renderBlocks(input) {
    const lines = String(input).replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(/^\u0000LEANBLOCK:(\d+):\u0000$/);
      const head = heading(line);
      const quoteMatch = quote(line);
      const item = listItem(line);

      if (isBlank(line)) { index += 1; continue; }
      if (fence) {
        output.push(Number(fence[1]));
        index += 1;
      } else if (head) {
        output.push(`<h${head[1].length}>${renderInline(head[2])}</h${head[1].length}>`);
        index += 1;
      } else if (rule(line)) {
        output.push('<hr>');
        index += 1;
      } else if (quoteMatch) {
        const quoted = [];
        while (index < lines.length && quote(lines[index])) {
          quoted.push(quote(lines[index])[1]);
          index += 1;
        }
        output.push(`<blockquote>${renderBlocks(quoted.join('\n'))}</blockquote>`);
      } else if (item && item[1].length < 8) {
        const list = parseList(lines, index);
        output.push(list.html);
        index = list.index;
      } else if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
        const table = parseTable(lines, index);
        output.push(table.html);
        index = table.index;
      } else {
        const paragraph = [];
        while (index < lines.length) {
          const current = lines[index];
          if (isBlank(current) || isFence(current) || heading(current) || rule(current) || quote(current)
          || (listItem(current)?.[1].length < 8)) break;
          paragraph.push(current);
          index += 1;
          if (current.includes('|') && isTableDivider(lines[index] ?? '')) break;
        }
        if (paragraph.length && isTableDivider(lines[index] ?? '')) {
          if (paragraph.length > 1) output.push(`<p>${renderInline(paragraph.slice(0, -1).join('\n'))}</p>`);
          const table = parseTable(lines, index - 1);
          output.push(table.html);
          index = table.index;
        } else {
          output.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
        }
      }
    }

    return output.map(value => typeof value === 'number' ? `\u0000LEANBLOCK:${value}:\u0000` : value).join('');
  }

  function render(source = '') {
    const text = String(source).replace(/\r\n?/g, '\n');
    const blocks = [];
    const placeholders = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, language, code) => {
      const lang = language.trim().split(/\s+/)[0] || 'text';
      const command = /^(?:bash|sh|shell|zsh|fish|console|terminal|powershell|pwsh|cmd|batch)$/i.test(lang);
      blocks.push(`
        <div class="code-block${command ? ' command-block' : ''}">
          <span class="code-language">${escapeHtml(lang)}</span>
          <button class="code-copy" type="button" data-copy-code title="Copy code">${command ? 'Copy commands' : 'Copy'}</button>
          <pre><code data-language="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>
        </div>`);
      return `\u0000LEANBLOCK:${blocks.length - 1}:\u0000`;
    });

    return renderBlocks(placeholders).replace(/\u0000LEANBLOCK:(\d+):\u0000/g, (_, index) => blocks[Number(index)] || '');
  }

  const root = typeof self !== 'undefined' ? self : globalThis;
  if (typeof module === 'object' && module.exports) module.exports = { render };
  root.LeanMarkdown = { render };
})();
