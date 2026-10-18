// Keep synthetic adapters focused on the named event payload even when the
// runtime appends other reference data after its single-line JSON paragraph.
import type { Entry } from '../../src/store.js';

export function readReferenceEvents(prompt: string): (Entry & { detailTruncated?: boolean })[] {
  const marker = 'Reference events (JSON data):\n\n';
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error('Missing reference events payload');
  const events: unknown = JSON.parse(prompt.slice(start + marker.length).split('\n\n', 1)[0]!);
  if (!Array.isArray(events)) throw new Error('Reference events payload must be an array');
  return events;
}
