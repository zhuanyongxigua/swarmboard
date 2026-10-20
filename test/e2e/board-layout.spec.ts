import { openResources } from './settings-helpers.js';
// Exercise the uneven-column regression in a real browser, including keyboard
// access to overflowed tasks and preservation of the complete saved content.
import { test, expect } from '@playwright/test';

test('task columns occupy the removed total toolbar space in both languages', async ({ page, request }, info) => {
  expect((await request.post('/api/tasks', { data: { title: 'Layout: compact task header' } })).ok()).toBe(true);
  for (const lang of ['zh-CN', 'en']) {
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('.task-board')).toBeVisible();
    const geometry = await page.locator('.task-panel').evaluate(panel => {
      const board = panel.querySelector('.task-board')!.getBoundingClientRect();
      return { panelTop: panel.getBoundingClientRect().top, boardTop: board.top,
        columnTops: [...panel.querySelectorAll('.task-column')].map(column => column.getBoundingClientRect().top) };
    });
    console.info(JSON.stringify({ lang, ...geometry }));
    await info.attach(`task-header-${lang}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
    await expect(page.locator('.task-panel > .panel-toolbar')).toHaveCount(0);
    expect(Math.abs(geometry.boardTop - geometry.panelTop)).toBeLessThan(1);
    expect(geometry.columnTops).toHaveLength(3);
    expect(geometry.columnTops.every(top => Math.abs(top - geometry.boardTop) < 1)).toBe(true);
    const counts = await page.locator('.column-heading > span').allTextContents();
    expect(counts).toHaveLength(3); expect(counts.every(value => /^\d+$/.test(value))).toBe(true);
    await page.getByRole('tab', { name: lang === 'en' ? 'Shared board' : '共享面板', exact: true }).click();
    await expect(page.locator('#panel-shared > .panel-toolbar')).toBeVisible();
  }
});

test('keeps empty and populated columns aligned and scrolls only the overflowing list', async ({ page, request }) => {
  const title = 'Layout: a deliberately long task title that must remain readable without making every card excessively tall';
  const description = 'Follow-up depends on cee7ccb3-0844-46ba-9ad6-4814067ee5e6. ' + 'Keep the complete description in task details. '.repeat(12);
  let firstId = '', lastId = '';
  for (let i = 0; i < 12; i++) {
    const response = await request.post('/api/tasks', { data: { title: `${title} ${i}`, description } });
    expect(response.ok()).toBe(true); const task = await response.json();
    const changed = await request.patch(`/api/tasks/${task.id}`, { data: { expectedVersion: 1, status: 'blocked' } });
    expect(changed.ok()).toBe(true); firstId ||= task.id; lastId = task.id;
  }
  await page.setViewportSize({ width: 1089, height: 714 }); await page.goto('/');
  const board = page.getByRole('region', { name: '任务状态看板' });
  const blocked = page.locator('[data-status="pending"] .column-list');
  await expect(blocked.locator(`[data-task-id="${lastId}"]`)).toBeAttached();
  const geometry = await page.locator('.column-list').evaluateAll(lists => lists.map(list => {
    const rect = list.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
  }));
  expect(Math.max(...geometry.map(r => r.bottom)) - Math.min(...geometry.map(r => r.bottom))).toBeLessThan(1);
  expect(Math.max(...geometry.map(r => r.top)) - Math.min(...geometry.map(r => r.top))).toBeLessThan(1);
  expect(await blocked.evaluate(list => list.scrollHeight > list.clientHeight)).toBe(true);
  const card = blocked.locator(`[data-task-id="${lastId}"]`);
  await card.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(`${title} 11`);
  await expect(page.getByLabel('任务 ID', { exact: true })).toHaveValue(lastId);
  await expect(page.getByLabel('任务说明')).toHaveValue(description);
  await page.keyboard.press('Escape');
  await blocked.evaluate(list => { list.scrollTop = 0; });
  await board.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await blocked.hover(); await page.mouse.wheel(0, 360);
  await expect.poll(() => blocked.evaluate(list => list.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('[data-status="todo"] .column-list').evaluate(list => list.scrollTop)).toBe(0);
  await blocked.evaluate(list => { list.scrollTop = list.scrollHeight; });
  const first = blocked.locator(`[data-task-id="${firstId}"]`);
  await first.focus();
  await expect(first.locator('.task-title')).toHaveAttribute('title', `${title} 0`);
  expect(await first.innerText()).not.toContain('暂无活跃资源声明');
  expect(await first.innerText()).not.toContain('cee7ccb3-0844-46ba-9ad6-4814067ee5e6');
});

test('keeps readable columns and keyboard navigation inside a narrow viewport', async ({ page, request }) => {
  const response = await request.post('/api/tasks', { data: { title: 'Layout: narrow viewport target' } });
  expect(response.ok()).toBe(true); const task = await response.json();
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { expectedVersion: 1, status: 'blocked' } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const board = page.getByRole('region', { name: '任务状态看板' });
  await expect(page.locator('[data-status="pending"]')).toBeAttached();
  expect(await board.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const columns = await page.locator('.task-column').evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect(); return { width: rect.width, top: rect.top };
  }));
  expect(columns.every(column => column.width >= 240 && Math.abs(column.top - columns[0]!.top) < 1)).toBe(true);
  await board.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => board.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '查看任务 Layout: narrow viewport target', exact: true }).focus();
  await page.keyboard.press('Enter'); await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Layout: narrow viewport target');
  await page.keyboard.press('Escape');
  await openResources(page);
  await expect(page.getByLabel('用户提示词内容', { exact: true })).toBeVisible();
});
