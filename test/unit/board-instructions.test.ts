// Verify independent prompt snapshots and explicit clears without a model.
import { describe, expect, it } from 'vitest';
import { boardInstructions } from '../../src/board-instructions.js';
import type { Preferences } from '../../src/store.js';
const value = (text: string, version: number): Preferences => ({ boardId: 'synthetic-board', text, version, source: 'human-input', updatedAt: null });
describe('board instruction snapshots', () => {
  it('keeps the existing preference envelope and independent user prompt in one revision', () => {
    const result = boardInstructions(value('System setting', 2), value('User setting', 4));
    expect(JSON.parse(result.revision)).toMatchObject({ text: 'System setting', version: 2, userPrompt: { text: 'User setting', version: 4 } });
    expect(result.text).toContain('Current board preferences:\n' + result.revision);
    expect(result.text).toContain('do not replace the harness built-in system instructions');
  });
  it('changes revision on either edit or clear and never restores the previous field', () => {
    const system = value('System setting', 2), user = value('User setting', 4);
    const original = boardInstructions(system, user);
    const cleared = boardInstructions(system, value('', 5));
    expect(cleared.revision).not.toBe(original.revision);
    expect(JSON.parse(cleared.revision)).toMatchObject({ text: system.text, userPrompt: { text: '', version: 5 } });
    const both = boardInstructions(value('', 3), value('', 5));
    expect(JSON.parse(both.revision)).toMatchObject({ text: '', userPrompt: { text: '' } });
    expect(both.text).not.toContain('User setting');
    expect(both.text).not.toContain('System setting');
  });
});
