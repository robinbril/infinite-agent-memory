'use strict';

const fs = require('node:fs');

const MAX_PAGE_BYTES = 64 * 1024;
const EVIDENCE_SECTION = /^(what|key facts|decisions)\b/i;
const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

function matchesIndex(stat, indexed) {
  return stat.isFile() && indexed && Math.round(stat.mtimeMs) === indexed[0] && stat.size === indexed[1];
}

// null means the indexed page can no longer be used. An empty string keeps the
// normal cached excerpt when the page is larger than the on-demand read limit.
function readIndexedPage(file, indexed) {
  try {
    const stat = fs.lstatSync(file);
    if (!matchesIndex(stat, indexed)) return null;
    if (stat.size > MAX_PAGE_BYTES) return '';

    const fd = fs.openSync(file, 'r');
    try {
      if (!matchesIndex(fs.fstatSync(fd), indexed)) return null;
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) return null;
        offset += count;
      }
      return matchesIndex(fs.fstatSync(fd), indexed) ? buffer.toString('utf8') : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function* passages(body) {
  let headings = [];
  let lines = [];
  let indent = null;
  let continuationIndent = 0;
  let fence = null;
  const bodyLines = body.split(/\r?\n/);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.+)/);
    const bullet = line.match(/^( *)(?:[-*+]|\d+[.)])[ \t]+/);
    const startsItem = bullet && (indent === null || bullet[1].length <= indent);
    if (indent !== null && !line.trim()) {
      let next = i + 1;
      while (next < bodyLines.length && !bodyLines[next].trim()) next++;
      if (bodyLines[next]?.startsWith(' '.repeat(continuationIndent))) {
        lines.push(bodyLines.slice(i, next).join('\n'));
        i = next - 1;
        continue;
      }
    }
    if (heading || marker || !line.trim() || startsItem) {
      if (lines.length) yield { headings, text: lines.join('\n') };
      lines = [];
      indent = null;
    }

    if (marker) {
      fence = marker[1];
    } else if (heading && heading[1].length <= 2) {
      headings = heading[1].length === 2 && EVIDENCE_SECTION.test(heading[2]) ? [line] : [];
    } else if (heading && headings.length) {
      headings = [...headings.filter(value => value.match(/^#+/)[0].length < heading[1].length), line];
    } else if (headings.length && line.trim()) {
      if (startsItem) {
        indent = bullet[1].length;
        continuationIndent = bullet[0].length;
      }
      lines.push(line);
    }
  }
  if (lines.length) yield { headings, text: lines.join('\n') };
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(text) {
  return text.replace(/&(amp|lt|gt|quot);/g, entity => XML_ENTITIES[entity]);
}

function clipText(text, budget) {
  if (text.length <= budget) return text;
  return text.slice(0, budget - 4).replace(/&[^;]*$/, '').replace(/[\uD800-\uDBFF]$/, '') + '\n...';
}

function buildEvidenceExtract(body, fallback, groups, tokenize, budget) {
  const overviewText = fallback.replace(/\r\n/g, '\n');
  const query = new Map();
  for (const group of groups) {
    for (const token of group) query.set(token, group[group.length - 1]);
  }
  let best = '';
  let bestScore = 1;
  for (const passage of passages(body)) {
    if (overviewText.includes(passage.text)) continue;
    const score = new Set(tokenize(passage.text).map(token => query.get(token)).filter(Boolean)).size;
    if (score <= bestScore) continue;
    const evidence = escapeXml([...passage.headings, passage.text].join('\n'));
    if (evidence.length > budget) continue;
    best = evidence;
    bestScore = score;
  }

  const remaining = budget - best.length - 2;
  const overview = escapeXml(overviewText);
  if (!best) return clipText(overview, budget);
  return overview && remaining >= 120 ? `${best}\n\n${clipText(overview, remaining)}` : best;
}

module.exports = { buildEvidenceExtract, escapeXml, unescapeXml, readIndexedPage };
