// Ship opt-in adapter modules separately so the portable core never imports a
// vendor implementation merely to make its code available to a trusted host.
import { build } from 'esbuild';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function buildHarnessModules(root, destination) {
  const realRoot = await realpath(root);
  const directory = path.join(root, 'src/harness');
  const results = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const input = path.join(directory, entry.name, 'index.ts');
    let info;
    try { info = await lstat(input); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) {
      throw new Error('Invalid checked-in harness module entry');
    }
    results.push(await build({
      absWorkingDir: root,
      entryPoints: [input],
      outfile: path.join(destination, 'server/harness', entry.name, 'index.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
      legalComments: 'eof',
      sourcemap: false,
      metafile: true,
      plugins: [{ name: 'portable-harness-source', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind !== 'entry-point' && (path.isAbsolute(args.path) || args.path.startsWith('file:'))) {
            throw new Error('Harness module absolute import is not portable');
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
          const relative = path.relative(realRoot, await realpath(args.path));
          if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
            throw new Error('Harness module outside source root is not distributable');
          }
        });
      } }],
    }));
  }
  return results;
}
