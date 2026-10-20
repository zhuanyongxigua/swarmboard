// Keep repository entrypoints and the documentation map usable without network
// access; report local drift before a documentation-only change reaches main.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_ROUTES = ['docs/index.md', 'docs/architecture.md', 'docs/harness.md',
  'docs/rules/README.md', 'docs/decisions/index.md'];
const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README.zh-CN.md'];

function markdownFiles(root, relative = 'docs') {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? markdownFiles(root, name)
      : entry.isFile() && name.endsWith('.md') ? [name] : [];
  });
}

function proseLines(text) {
  let fence;
  return text.split(/\r?\n/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) {
      fence = fence ? undefined : marker[1];
      return '';
    }
    return fence ? '' : line;
  });
}

function links(text) {
  return proseLines(text).flatMap((line, index) => {
    const prose = line.replace(/`+[^`]*`+/g, '');
    const matches = [...prose.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+['"][^)]*)?\s*\)/g)]
      .map(match => ({ target: match[1] ?? match[2], line: index + 1 }));
    const definition = prose.match(/^ {0,3}\[([^\]^][^\]]*)\]:\s*(?:<([^>]+)>|([^\s]+))/);
    if (definition) matches.push({ target: definition[2] ?? definition[3], line: index + 1 });
    return matches;
  });
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  const lines = proseLines(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
    const atx = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const setext = index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1]);
    const heading = atx?.[1] ?? (setext && line.trim() ? line.trim() : undefined);
    if (!heading) continue;
    const slug = heading.replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').trim().replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

export function checkDocs(root) {
  root = path.resolve(root);
  const findings = [];
  const report = (file, line, message) => findings.push({ file, line, message });
  const docs = markdownFiles(root);
  const files = [...ROOT_FILES, ...docs];
  const texts = new Map();
  const edges = new Map();
  const headingCache = new Map();
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) { report(file, 1, 'Required entrypoint is missing'); continue; }
    texts.set(file, readFileSync(absolute, 'utf8'));
  }
  if (texts.has('CLAUDE.md') && texts.get('CLAUDE.md').trim() !== '@AGENTS.md') {
    report('CLAUDE.md', 1, 'Keep only @AGENTS.md');
  }
  if (texts.has('AGENTS.md') && Buffer.byteLength(texts.get('AGENTS.md')) > 8192) {
    report('AGENTS.md', 1, 'Keep the startup index within 8 KiB');
  }
  for (const [file, text] of texts) {
    edges.set(file, new Set());
    for (const link of links(text)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.target)) continue;
      let target, fragment;
      try {
        const separator = link.target.indexOf('#');
        target = decodeURIComponent((separator < 0 ? link.target : link.target.slice(0, separator)).split('?')[0]);
        fragment = separator < 0 ? '' : decodeURIComponent(link.target.slice(separator + 1));
      } catch { report(file, link.line, 'Malformed local link encoding'); continue; }
      const destination = target ? path.resolve(root, path.dirname(file), target) : path.join(root, file);
      const relative = path.relative(root, destination).split(path.sep).join('/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        report(file, link.line, 'Local link escapes the repository'); continue;
      }
      if (!existsSync(destination)) { report(file, link.line, `Missing local target: ${relative}`); continue; }
      if (relative.endsWith('.md')) edges.get(file).add(relative);
      if (fragment && relative.endsWith('.md') && statSync(destination).isFile()) {
        if (!headingCache.has(relative)) headingCache.set(relative, anchors(readFileSync(destination, 'utf8')));
        if (!headingCache.get(relative).has(fragment)) report(file, link.line, `Missing heading anchor: ${relative}#${fragment}`);
      }
    }
  }
  for (const route of ENTRY_ROUTES) {
    if (!edges.get('AGENTS.md')?.has(route)) report('AGENTS.md', 1, `Missing first-level route: ${route}`);
  }
  for (const file of ['README.md', 'README.zh-CN.md']) {
    if (!edges.get(file)?.has('docs/index.md')) report(file, 1, 'Link the documentation index');
  }
  const reachable = new Set();
  const pending = ['docs/index.md'];
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const target of edges.get(file) ?? []) pending.push(target);
  }
  for (const file of docs) {
    if (!reachable.has(file)) report(file, 1, 'Document is unreachable from docs/index.md');
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkDocs(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  for (const item of findings) console.error(`${item.file}:${item.line}: ${item.message}`);
  if (findings.length) process.exitCode = 1;
  else console.log('Documentation entrypoints, local links and index reachability passed.');
}
