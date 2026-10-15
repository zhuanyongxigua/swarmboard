import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep shared data outside the plugin installation so updates and separate client processes retain one board. */
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const override = env.SWARMBOARD_DB_PATH?.trim();
  if (override) return override === ':memory:' ? override : resolve(override);
  const directory = platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(directory, 'swarmboard', 'board.sqlite');
}

/** Resolve bundled assets relative to this module, independent of the desktop client's working directory. */
export function defaultWidgetPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SWARMBOARD_WIDGET_PATH?.trim()) return resolve(env.SWARMBOARD_WIDGET_PATH);
  const bundled = fileURLToPath(new URL('../widget.html', import.meta.url));
  const development = fileURLToPath(new URL('../dist/widget.html', import.meta.url));
  return existsSync(bundled) ? bundled : existsSync(development) ? development : bundled;
}
