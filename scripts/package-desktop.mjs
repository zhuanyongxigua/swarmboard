// Archive only the built plugin whitelist, keeping local data and credentials
// out of the distributable even when they exist elsewhere in the checkout.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist/desktop');
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const archive = path.join(root, `dist/swarmboard-desktop-${packageInfo.version}.zip`);
const allowed = new Set(['BUILD.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'docs', 'mcp.json', 'plugin.json', 'server', 'skills', 'widget.html']);
for (const name of await readdir(destination)) {
  if (!allowed.has(name)) throw new Error(`Unexpected desktop package entry: ${name}`);
}
await rm(archive, { force: true });
execFileSync('zip', ['-X', '-q', '-r', archive, ...[...allowed].sort()], { cwd: destination, stdio: 'inherit' });
console.log(`Desktop ZIP: ${path.relative(root, archive)}`);
