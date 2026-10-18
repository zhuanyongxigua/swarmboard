// Verify truthful progress rendering at data boundaries without starting a model or board runtime.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskProgress, type TaskProgressSnapshot } from '../../web/TaskProgress.js';

const report: TaskProgressSnapshot = {
  percent: 70, state: 'active', phase: 'Acceptance checks', verified: 'Reviewed change',
  remaining: 'Real environment validation', updatedAt: '2026-10-18T12:00:00Z', reportedBy: 'synthetic-worker',
};
const render = (progress?: TaskProgressSnapshot | null) => renderToStaticMarkup(createElement(TaskProgress, { taskTitle: 'Synthetic task', progress }));

describe('reported progress view', () => {
  it('shows unknown without inventing zero for missing, uncertain or malformed estimates', () => {
    for (const progress of [undefined, null, { ...report, state: 'unknown' as const, percent: null },
      { ...report, percent: Number.NaN }, { ...report, percent: -1 }, { ...report, percent: 101 }]) {
      const html = render(progress);
      expect(html).toContain('待评估');
      expect(html).toContain('data-progress-state="unknown"');
      expect(html).not.toContain('aria-valuenow=');
      expect(html).not.toContain('task-progress-fill');
    }
  });

  it('preserves reported zero, completion and waiting estimates without claiming model execution', () => {
    for (const percent of [0, 35, 100]) {
      const html = render({ ...report, state: 'waiting', percent });
      expect(html).toContain(`aria-valuenow="${percent}"`);
      expect(html).toContain('data-progress-state="waiting"');
      expect(html).toContain('等待中');
      expect(html).not.toContain('执行中');
      expect(html).not.toContain('已完成');
    }
  });

  it('treats the freely reported phase as literal text and keeps a single explicit evidence button', () => {
    const html = render({ ...report, phase: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('type="button"');
    expect(html).toContain('进度依据');
  });
});
