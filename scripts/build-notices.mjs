// Collect licenses from every independent bundle so optional adapter packages
// receive the same third-party attribution as the core and UI distributions.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function dependencyNotices(root, metafiles, extraPackages = []) {
  const directories = new Set();
  for (const input of metafiles.flatMap(metafile => Object.keys(metafile.inputs))) {
    const relative = path.relative(root, path.resolve(root, input));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new Error('Bundle dependency outside package root');
    }
    const match = relative.replaceAll(path.sep, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) directories.add(path.join(root, match[1]));
  }
  for (const name of extraPackages) directories.add(path.join(root, 'node_modules', name));
  const notices = [];
  for (const directory of [...directories].sort()) {
    const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|notice)(\.|$)/i.test(name));
    const texts = await Promise.all(licenses.map(name => readFile(path.join(directory, name), 'utf8')));
    notices.push(`${info.name}@${info.version} (${info.license ?? 'see upstream license'})\n${texts.join('\n')}`);
  }
  return notices.join('\n\n--------------------\n\n') + '\n';
}
