// Verify persistent data stays outside plugin installs across supported desktop platforms.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDatabasePath, defaultWidgetPath } from '../../src/paths.js';
describe('desktop paths', () => {
  it('uses platform user-data directories rather than the working directory', () => {
    expect(defaultDatabasePath({}, 'darwin', '/home/test')).toBe('/home/test/Library/Application Support/swarmboard/board.sqlite');
    expect(defaultDatabasePath({ XDG_DATA_HOME: '/custom/data' }, 'linux', '/home/test')).toBe('/custom/data/swarmboard/board.sqlite');
    expect(defaultDatabasePath({}, 'linux', '/home/test')).toBe('/home/test/.local/share/swarmboard/board.sqlite');
    expect(defaultDatabasePath({ LOCALAPPDATA: '/custom/local' }, 'win32', '/home/test')).toBe('/custom/local/swarmboard/board.sqlite');
    expect(defaultDatabasePath({}, 'win32', '/home/test')).toBe('/home/test/AppData/Local/swarmboard/board.sqlite');
  });
  it('supports explicit isolated databases and asset overrides', () => {
    expect(defaultDatabasePath({ SWARMBOARD_DB_PATH: ':memory:' })).toBe(':memory:');
    expect(defaultDatabasePath({ SWARMBOARD_DB_PATH: './isolated.sqlite' })).toBe(resolve('isolated.sqlite'));
    expect(defaultWidgetPath({ SWARMBOARD_WIDGET_PATH: './custom.html' })).toBe(resolve('custom.html'));
    expect(defaultWidgetPath({})).toBe(resolve('dist/widget.html'));
  });
});
