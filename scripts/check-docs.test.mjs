// Prove documentation drift is rejected with disposable repositories instead of
// changing the real documentation tree or relying on network checks.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs } from './check-docs.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'swarmboard-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const append = (file, text) => put(file, readFileSync(path.join(root, file), 'utf8') + '\n' + text);
  put('AGENTS.md', ['docs/index.md', 'docs/architecture.md', 'docs/harness.md',
    'docs/rules/README.md', 'docs/decisions/index.md'].map(file => `[route](${file})`).join('\n'));
  put('CLAUDE.md', '@AGENTS.md\n');
  for (const file of ['README.md', 'README.zh-CN.md']) put(file, '[Docs](docs/index.md)');
  put('docs/index.md', '[Architecture](architecture.md)\n[Harness](harness.md)\n[Rules](rules/README.md)\n[Decisions](decisions/index.md)');
  put('docs/architecture.md', '# 协作架构\n## State & recovery\n## State & recovery\n');
  for (const file of ['docs/harness.md', 'docs/rules/README.md', 'docs/decisions/index.md']) put(file, '# Guide\n');
  return { root, put, append };
}

test('accepts indexed documents, Unicode and duplicate heading anchors, references and images', t => {
  const { root, put, append } = fixture(t);
  put('docs/assets/sample.svg', '<svg/>');
  append('docs/index.md', '[State](architecture.md#state--recovery-1)\n[标题](architecture.md#%E5%8D%8F%E4%BD%9C%E6%9E%B6%E6%9E%84)\n[ref]: architecture.md\n![asset](assets/sample.svg)\n[external](https://example.invalid/no-network)\n```md\n[example](missing.md)\n```');
  assert.deepEqual(checkDocs(root), []);
});

test('rejects a missing local target and reports its source line', t => {
  const { root, append } = fixture(t);
  append('docs/harness.md', '[missing](absent.md)');
  assert.ok(checkDocs(root).some(x => x.file === 'docs/harness.md' && x.line === 3 && x.message.includes('Missing local target')));
});

test('rejects an existing Markdown file with an invalid heading fragment', t => {
  const { root, append } = fixture(t);
  append('docs/index.md', '[wrong](architecture.md#missing-heading)');
  assert.ok(checkDocs(root).some(x => x.message.includes('Missing heading anchor')));
});

test('rejects isolated docs and accepts them once linked from an indexed document', t => {
  const { root, put, append } = fixture(t);
  put('docs/new-topic.md', '# New topic');
  assert.ok(checkDocs(root).some(x => x.file === 'docs/new-topic.md' && x.message.includes('unreachable')));
  append('docs/harness.md', '[New topic](new-topic.md)');
  assert.deepEqual(checkDocs(root), []);
});

test('rejects duplicate Claude instructions, missing entrypoints and an oversized root guide', t => {
  const { root, put } = fixture(t);
  put('CLAUDE.md', '@AGENTS.md\nAnother instruction');
  put('AGENTS.md', 'x'.repeat(8193));
  rmSync(path.join(root, 'README.zh-CN.md'));
  const findings = checkDocs(root);
  assert.ok(findings.some(x => x.file === 'CLAUDE.md' && x.message.includes('Keep only')));
  assert.ok(findings.some(x => x.file === 'AGENTS.md' && x.message.includes('8 KiB')));
  assert.ok(findings.some(x => x.file === 'AGENTS.md' && x.message.includes('first-level route')));
  assert.ok(findings.some(x => x.file === 'README.zh-CN.md' && x.message.includes('missing')));
});

test('rejects missing README navigation, malformed local encoding and repository escapes', t => {
  const { root, put, append } = fixture(t);
  put('README.md', '# No navigation');
  append('docs/index.md', '[bad](%zz.md)\n[outside](../../private.md)');
  const findings = checkDocs(root);
  assert.ok(findings.some(x => x.file === 'README.md' && x.message.includes('documentation index')));
  assert.ok(findings.some(x => x.message.includes('encoding')));
  assert.ok(findings.some(x => x.message.includes('escapes')));
});
