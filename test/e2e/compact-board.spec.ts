// Exercise compact display groups against a fresh real database for each case,
// so hidden terminal records and explicit state changes are verified separately.
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/app.js';

type SavedTask = { id: string; title: string; status: string; version: number };
const test = base.extend<{ isolatedUrl: string }>({
  isolatedUrl: async ({ playwright: _playwright }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'swarmboard-compact-browser-'));
    const service = await startServer({ port: 0, dbPath: join(directory, 'board.sqlite') });
    try { await use(service.url); }
    finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});

async function savedTasks(request: APIRequestContext, url: string): Promise<SavedTask[]> {
  const response = await request.get(`${url}/api/board`);
  expect(response.ok()).toBe(true);
  return (await response.json()).tasks;
}

async function createTask(request: APIRequestContext, url: string, status: string): Promise<SavedTask> {
  const response = await request.post(`${url}/api/tasks`, { data: { title: `Compact ${status}` } });
  expect(response.ok()).toBe(true);
  const task = await response.json();
  if (status === 'todo') return task;
  const changed = await request.patch(`${url}/api/tasks/${task.id}`, { data: { expectedVersion: 1, status } });
  expect(changed.ok()).toBe(true);
  return (await savedTasks(request, url)).find(item => item.id === task.id)!;
}

test('groups review and blocked cards while preserving hidden terminal tasks', async ({ page, request, isolatedUrl }, testInfo) => {
  const tasks: SavedTask[] = [];
  for (const status of ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']) {
    tasks.push(await createTask(request, isolatedUrl, status));
  }
  await page.goto(isolatedUrl);
  const columns = page.locator('.task-column');
  await expect(columns.locator('h2')).toHaveText(['待认领', '进行中', '待处理']);
  const pending = columns.filter({ has: page.getByRole('heading', { name: '待处理', exact: true }) });
  await expect(pending.locator('.column-heading > span')).toHaveText('2');
  for (const [status, label] of [['in_review', '待验收'], ['blocked', '受阻']]) {
    const task = tasks.find(item => item.status === status)!;
    const card = pending.locator(`[data-card-id="${task.id}"]`);
    const open = card.getByRole('button', { name: `查看任务 ${task.title}`, exact: true });
    await expect(open).toBeVisible();
    await expect(open).toHaveAccessibleDescription(label!);
    await expect(card.getByText(label!, { exact: true })).toBeVisible();
    const dot = card.locator('.task-state-dot');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    const appearance = await dot.evaluate(element => {
      const style = getComputedStyle(element);
      return { color: style.backgroundColor, width: style.width, height: style.height, radius: style.borderRadius };
    });
    const rgb = appearance.color.match(/\d+/g)!.map(Number);
    expect(rgb[status === 'in_review' ? 1 : 0]).toBeGreaterThan(rgb[status === 'in_review' ? 0 : 1]!);
    expect(appearance.width).toBe(appearance.height);
    expect(appearance.radius).toBe('50%');
  }
  for (const task of tasks.filter(item => ['done', 'canceled'].includes(item.status))) {
    await expect(page.locator(`[data-card-id="${task.id}"]`)).toHaveCount(0);
  }
  expect(await savedTasks(request, isolatedUrl)).toEqual(expect.arrayContaining(tasks.map(task => expect.objectContaining(task))));
  await page.reload();
  await expect(columns).toHaveCount(3);
  expect((await savedTasks(request, isolatedUrl)).length).toBe(6);
  await page.screenshot({ path: testInfo.outputPath('compact-board-desktop.png'), fullPage: true });
});

test('requires an explicit pending state and canceling or dropping within the group writes nothing', async ({ page, request, isolatedUrl }) => {
  const task = await createTask(request, isolatedUrl, 'todo');
  await page.goto(isolatedUrl);
  const card = page.locator(`[data-card-id="${task.id}"]`);
  const pending = page.locator('[data-drop-status="pending"]');
  const chooser = page.getByRole('dialog', { name: '选择待处理状态', exact: true });
  let writes = 0;
  page.on('request', value => {
    if (value.method() === 'PATCH' && value.url().endsWith(`/api/tasks/${task.id}`)) writes++;
  });
  for (const cancel of ['escape', 'button']) {
    await card.dragTo(pending);
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'todo', version: 1 });
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else await chooser.getByRole('button', { name: '取消', exact: true }).click();
    await expect(chooser).toHaveCount(0);
    expect(writes).toBe(0);
    expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'todo', version: 1 });
  }
  await card.dragTo(pending);
  await chooser.getByRole('button', { name: '待验收', exact: true }).click();
  await expect(page.locator('[data-status="pending"]').getByText('待验收', { exact: true })).toBeVisible();
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'in_review', version: 2 });
  expect(writes).toBe(1);
  await card.dragTo(pending);
  await expect(chooser).toHaveCount(0);
  expect(writes).toBe(1);
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'in_review', version: 2 });
  await card.dragTo(page.locator('[data-drop-status="in_progress"]'));
  await expect(page.locator('[data-status="in_progress"]').locator(`[data-card-id="${task.id}"]`)).toBeVisible();
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'in_progress', version: 3 });
  await card.dragTo(pending);
  await chooser.getByRole('button', { name: '受阻', exact: true }).click();
  await expect(page.locator('[data-status="pending"]').getByText('受阻', { exact: true })).toBeVisible();
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'blocked', version: 4 });
  expect(writes).toBe(3);
});

test('shows three aligned empty columns without inventing saved tasks', async ({ page, request, isolatedUrl }) => {
  await page.setViewportSize({ width: 1089, height: 714 });
  await page.goto(isolatedUrl);
  await expect(page.locator('.task-column h2')).toHaveText(['待认领', '进行中', '待处理']);
  await expect(page.locator('.column-empty')).toHaveCount(3);
  const bounds = await page.locator('.column-list').evaluateAll(lists => lists.map(list => {
    const rect = list.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
  }));
  expect(Math.max(...bounds.map(rect => rect.top)) - Math.min(...bounds.map(rect => rect.top))).toBeLessThan(1);
  expect(Math.max(...bounds.map(rect => rect.bottom)) - Math.min(...bounds.map(rect => rect.bottom))).toBeLessThan(1);
  expect(await savedTasks(request, isolatedUrl)).toEqual([]);
});

test('keeps both underlying pending states editable and hides only an explicit terminal change', async ({ page, request, isolatedUrl }) => {
  const task = await createTask(request, isolatedUrl, 'in_review');
  await page.goto(isolatedUrl);
  await page.getByRole('button', { name: `查看任务 ${task.title}`, exact: true }).click();
  const status = page.getByRole('combobox', { name: '状态', exact: true });
  await expect(status).toHaveValue('in_review');
  await status.selectOption('blocked');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'blocked', version: 3 });
  await expect(page.locator(`[data-card-id="${task.id}"]`).getByText('受阻', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `查看任务 ${task.title}`, exact: true }).click();
  await expect(status).toHaveValue('blocked');
  await status.selectOption('done');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator(`[data-card-id="${task.id}"]`)).toHaveCount(0);
  expect((await savedTasks(request, isolatedUrl)).find(item => item.id === task.id)).toMatchObject({ status: 'done', version: 4 });
});
