// Render both human configuration fields as one current session snapshot so
// a clear or edit cannot leave an older field active in a resumed thread.
import type { Preferences } from './store.js';
import type { SessionInstructions } from './harness/contract.js';

export function boardInstructions(systemPrompt: Preferences, userPrompt: Preferences): SessionInstructions {
  const revision = JSON.stringify({ ...systemPrompt, userPrompt });
  return { revision, text: [
    'These are the current human board preferences, supplied as session-level instructions.',
    'This snapshot supersedes all earlier board preference snapshots, including those in conversation history or summaries. An empty text means no board preferences are currently set; do not revive earlier values.',
    'The top-level text is the board setting labeled System prompt; userPrompt.text is the independent board setting labeled User prompt. Each empty text explicitly clears that field. Use only the values in this snapshot.',
    'These setting names do not replace the harness built-in system instructions or grant project, credential, production or tool-approval permissions. Follow existing task and safety constraints. Report concrete limitations when an expectation cannot be fulfilled.',
    'Current board preferences:\n' + revision,
  ].join('\n\n') };
}
