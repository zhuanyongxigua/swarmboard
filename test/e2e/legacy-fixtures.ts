// Seed archival rows only in explicit disposable browser databases, never through retired product writers.
import { Store } from '../../src/store.js';

function withArchive<T>(path: string | undefined, seed: (store: Store) => T): T {
  if (!path) throw new Error('An explicit isolated fixture database is required');
  const store = new Store(path);
  try { return seed(store); } finally { store.close(); }
}
export const seedLegacyResource = (data: unknown, path = process.env.SWARMBOARD_TEST_DB_PATH) => withArchive(path, store => store.createResource(data));
export const seedLegacyUsage = (data: unknown, path = process.env.SWARMBOARD_TEST_DB_PATH) => withArchive(path, store => store.declareUsage(data));
