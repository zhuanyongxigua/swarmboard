// Build a relocatable desktop plugin so the host can launch its local MCP server
// without npm install, a running web server, or access to this source checkout.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist/desktop');
await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, 'server'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/stdio.ts'],
  outfile: path.join(destination, 'server/swarmboard.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: 'eof',
  sourcemap: false,
  metafile: true,
});
for (const name of ['plugin.json', 'mcp.json', 'LICENSE', 'README.md', 'README.zh-CN.md']) {
  await cp(path.join(root, name), path.join(destination, name));
}
await mkdir(path.join(destination, 'skills/shared-worker'), { recursive: true });
await cp(path.join(root, 'skills/shared-worker/SKILL.md'), path.join(destination, 'skills/shared-worker/SKILL.md'));
await cp(path.join(root, 'dist/widget.html'), path.join(destination, 'widget.html'));
// POSIX GUI launches need runtime discovery; Windows keeps native Node resolution.
await cp(path.join(root, 'scripts/launch-desktop.sh'), path.join(destination, 'server/launch.sh'));
const mcp = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8'));
if (process.platform !== 'win32') {
  mcp.mcpServers.swarmboard.command = 'sh';
  mcp.mcpServers.swarmboard.args = ['${PLUGIN_ROOT}/server/launch.sh'];
}
await writeFile(path.join(destination, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

await mkdir(path.join(destination, 'docs'), { recursive: true });
for (const name of ['architecture.md', 'testing.md', 'verification.md', 'setup.md', 'setup.zh-CN.md', 'event-workers.md', 'harness-adapters.md', 'external-collaborators.md', 'board-prompt-settings.md', 'collaboration-environment-ui.md']) {
  await cp(path.join(root, 'docs', name), path.join(destination, 'docs', name));
}
// Keep the README image links usable in the portable plugin as well as on GitHub.
for (const language of ['en', 'zh-CN']) {
  await mkdir(path.join(destination, 'docs/assets', language), { recursive: true });
  for (const image of ['tasks.png', 'settings.png', 'resources.png', 'shared.png']) {
    await cp(path.join(root, 'docs/assets', language, image), path.join(destination, 'docs/assets', language, image));
  }
}
// Preserve dependency license notices without shipping development dependencies or their source trees.
const packageDirectories = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packageDirectories.add(path.join(root, match[1]));
}
// The UI bundle is built separately, so include its direct runtime packages as well.
for (const name of ['react', 'react-dom', 'scheduler', '@modelcontextprotocol/ext-apps']) {
  packageDirectories.add(path.join(root, 'node_modules', name));
}
const notices = [];
for (const directory of [...packageDirectories].sort()) {
  const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|notice)(\.|$)/i.test(name));
  const texts = await Promise.all(licenses.map(name => readFile(path.join(directory, name), 'utf8')));
  notices.push(`${info.name}@${info.version} (${info.license ?? 'see upstream license'})\n${texts.join('\n')}`);
}
await writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n') + '\n');
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(destination, 'BUILD.json'), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, runtime: 'node >=24', transport: 'stdio' }, null, 2) + '\n');
console.log(`Desktop plugin: ${path.relative(root, destination)}`);
