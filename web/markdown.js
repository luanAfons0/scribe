/* A small Markdown renderer for the Minutes, the same one Worklog's Page uses.
   It lives here rather than on a CDN because the Host serves web/ byte for
   byte and nothing else (FirstMate ADR-0008), and a Plugin Page that reaches
   the internet stops working the day the internet is not there.

   It covers what a person or a model writes in Minutes — paragraphs,
   headings, lists nested by indent, quotes, code, tables, emphasis and links — and nothing
   more. A bare address shows short, as spell.sh, and still goes to the whole
   address. Every character of the source is escaped before any Markdown is
   read, so text can never become markup; a link keeps only an http, https or
   mailto address, or a relative one. It defines two globals:
   renderMarkdown(text) → an HTML string, and markdownBlocks(text) → the same
   text cut into its blocks. scribe uses only the first; the file is kept the
   same as Worklog's, so a fix to one is a copy to the other. */
'use strict';

(function () {
  function escape(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** An address a link may keep, already escaped, or null for one it may not. */
  function safeAddress(escaped) {
    const plain = escaped.replace(/&amp;/g, '&').trim();
    if (/^(https?:|mailto:)/i.test(plain)) return escaped.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(plain) || plain.startsWith('//')) return null;
    return escaped.trim();
  }

  function link(text, escapedAddress, className) {
    const address = safeAddress(escapedAddress);
    if (address === null) return text;
    return (
      '<a href="' + address + '"' +
      // A bare address shows short, so its whole self is kept in the tooltip.
      (className ? ' class="' + className + '" title="' + address + '"' : '') +
      ' target="_blank" rel="noopener noreferrer">' + text + '</a>'
    );
  }

  /** A bare address as a person reads it: no scheme, no www, no last slash. */
  function short(url) {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  }

  /** One line of already escaped text, with its inline Markdown read. */
  function inline(escaped) {
    // Code spans first, and out of the way, so nothing inside one is read.
    const codes = [];
    let out = escaped.replace(/`([^`]+)`/g, function (_, code) {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    const links = [];
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, address) {
      links.push(link(text, address));
      return '\u0001' + (links.length - 1) + '\u0001';
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, function (_, before, url) {
      links.push(link(short(url), url, 'bare'));
      return before + '\u0001' + (links.length - 1) + '\u0001';
    });
    out = out
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    out = out.replace(/\u0001(\d+)\u0001/g, function (_, n) {
      return links[Number(n)];
    });
    return out.replace(/\u0000(\d+)\u0000/g, function (_, n) {
      return codes[Number(n)];
    });
  }

  const FENCE = /^\s*```/;
  const HEADING = /^(#{1,6})\s+(.*)$/;
  const QUOTE = /^\s*&gt;\s?(.*)$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const ROW = /\|/;
  const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  /** How far a line is indented, a tab counting as four spaces. */
  function indentOf(line) {
    return /^\s*/.exec(line)[0].replace(/\t/g, '    ').length;
  }

  function item(text) {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    return task
      ? '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ' +
          inline(task[2])
      : inline(text);
  }

  /**
   * The cells of one table row. A pipe inside a code span, or written as \\|,
   * is text and not a border. The pipes at either end are optional.
   */
  function cells(line) {
    const found = [];
    let cell = '';
    let code = false;
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      if (char === '\\' && line[at + 1] === '|') {
        cell += '|';
        at += 1;
      } else if (char === '`') {
        code = !code;
        cell += char;
      } else if (char === '|' && !code) {
        found.push(cell);
        cell = '';
      } else {
        cell += char;
      }
    }
    found.push(cell);
    if (/^\s*\|/.test(line)) found.shift();
    if (/\|\s*$/.test(line) && !/\\\|\s*$/.test(line)) found.pop();
    return found.map((text) => text.trim());
  }

  /** Whether line i starts a table: a row, then a delimiter row as wide. */
  function startsTable(lines, i) {
    return (
      i + 1 < lines.length &&
      ROW.test(lines[i]) &&
      DELIMITER.test(lines[i + 1]) &&
      cells(lines[i]).length === cells(lines[i + 1]).length
    );
  }

  /** One cell's text: a lone [ ] or [x] is a checkbox, as in a list. */
  function cell(text) {
    const task = /^\[([ xX])\]$/.exec(text);
    if (task) return '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '>';
    return inline(text);
  }

  /**
   * One table, starting at line i. The delimiter row sets each column's
   * alignment; a row with too few cells is filled, one with too many is cut.
   * Answers the HTML and the first line it did not read.
   */
  function table(lines, i) {
    const aligns = cells(lines[i + 1]).map((rule) => {
      const left = rule.startsWith(':');
      const right = rule.endsWith(':');
      if (left && right) return ' class="center"';
      if (right) return ' class="right"';
      return '';
    });
    const row = (line, tag) =>
      '<tr>' +
      aligns
        .map((align, n) => '<' + tag + align + '>' + cell(cells(line)[n] || '') + '</' + tag + '>')
        .join('') +
      '</tr>';
    const head = row(lines[i], 'th');
    const body = [];
    i += 2;
    while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
      body.push(row(lines[i], 'td'));
      i += 1;
    }
    return {
      // The wrapper scrolls, so a wide table never widens the card it is in.
      html:
        '<div class="table"><table><thead>' + head + '</thead>' +
        (body.length > 0 ? '<tbody>' + body.join('') + '</tbody>' : '') +
        '</table></div>',
      next: i,
    };
  }

  /**
   * One list, starting at line i and indented by base. A deeper item nests in
   * the item above it; a shallower one, or a change of bullet at this depth,
   * ends the list. Answers the HTML and the first line it did not read.
   */
  function list(lines, i, base) {
    const ordered = /\d/.test(ITEM.exec(lines[i])[2]);
    const items = [];
    while (i < lines.length) {
      const found = ITEM.exec(lines[i]);
      if (!found) break;
      const depth = indentOf(lines[i]);
      if (depth < base) break;
      if (depth > base && items.length > 0) {
        const nested = list(lines, i, depth);
        items[items.length - 1] += nested.html;
        i = nested.next;
        continue;
      }
      if (/\d/.test(found[2]) !== ordered) break;
      items.push(item(found[3]));
      i += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    return {
      html: '<' + tag + '>' + items.map((text) => '<li>' + text + '</li>').join('') + '</' + tag + '>',
      next: i,
    };
  }

  /** The source with every line end made one \n, as both globals read it. */
  function normal(source) {
    return String(source || '').replace(/\r\n?/g, '\n');
  }

  /**
   * Every block of the source, in order: its HTML, and the lines it came from
   * as [start, end). A block never starts or ends on a blank line.
   */
  function read(source) {
    const lines = escape(normal(source)).split('\n');
    const blocks = [];
    let i = 0;
    let start = 0;
    // A branch pushes before it moves i past its lines, so a block's end is
    // set when the loop comes round again, or when it stops.
    const close = () => {
      const last = blocks[blocks.length - 1];
      if (last && last.end === undefined) last.end = Math.min(i, lines.length);
    };
    const out = {
      push(html) {
        blocks.push({ html, start, end: undefined });
      },
    };

    while (i < lines.length) {
      close();
      const line = lines[i];
      start = i;

      if (line.trim() === '') {
        i += 1;
        continue;
      }

      if (FENCE.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !FENCE.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push('<pre><code>' + code.join('\n') + '</code></pre>');
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }

      if (RULE.test(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          quoted.push(QUOTE.exec(lines[i])[1]);
          i += 1;
        }
        // The quote was escaped once already; read it again as its own text.
        const inner = quoted.join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        out.push('<blockquote>' + renderMarkdown(inner) + '</blockquote>');
        continue;
      }

      if (startsTable(lines, i)) {
        const read = table(lines, i);
        out.push(read.html);
        i = read.next;
        continue;
      }

      if (ITEM.test(line)) {
        const read = list(lines, i, indentOf(line));
        out.push(read.html);
        i = read.next;
        continue;
      }

      const paragraph = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !FENCE.test(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !QUOTE.test(lines[i]) &&
        !ITEM.test(lines[i]) &&
        !startsTable(lines, i)
      ) {
        paragraph.push(inline(lines[i]));
        i += 1;
      }
      // A single newline is kept as a line break: a note is typed, not typeset.
      out.push('<p>' + paragraph.join('<br>') + '</p>');
    }
    close();

    return blocks;
  }

  function renderMarkdown(source) {
    return read(source)
      .map((block) => block.html)
      .join('');
  }

  /**
   * The source cut into its blocks. Each block is { source, html, after }:
   * after is the exact text up to the next block, so joining every source and
   * after gives back the source, less any blank lines before the first block.
   */
  function markdownBlocks(source) {
    const lines = normal(source).split('\n');
    const found = read(source);
    return found.map((block, n) => {
      const next = found[n + 1];
      const gap = next
        ? lines.slice(block.end, next.start).map((line) => line + '\n').join('')
        : lines.slice(block.end).join('\n');
      return {
        source: lines.slice(block.start, block.end).join('\n'),
        html: block.html,
        after: next || block.end < lines.length ? '\n' + gap : '',
      };
    });
  }

  globalThis.renderMarkdown = renderMarkdown;
  globalThis.markdownBlocks = markdownBlocks;
})();
