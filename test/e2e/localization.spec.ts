import { openResources, closeSettings } from './settings-helpers.js';
// Verify localized documentation previews use the real board and never translate stored user content.
import { test, expect } from '@playwright/test';

test('English preview supports real editing while Chinese remains the default', async ({ page, request }) => {
  const title = 'Keep user text 原样保留';
  const seeded = await request.post('/api/tasks', { data: { title, description: 'Original 中文 description', acceptanceCriteria: 'Stored text is unchanged by language selection' } });
  expect(seeded.ok()).toBe(true);
  const creates: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/tasks') creates.push(req.url()); });
  await page.goto('/?lang=en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('tab')).toHaveText(['Tasks', 'Shared board']);
  await expect(page.getByRole('heading', { name: 'To do', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discuss a plan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /New task|Create task/i })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: `View task ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('in_review');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('[data-status="pending"]').getByRole('button', { name: `View task ${title}`, exact: true })).toBeVisible();
  await openResources(page);
  await expect(page.getByLabel('User prompt text', { exact: true })).toBeVisible();
  await closeSettings(page); await page.getByRole('tab', { name: 'Shared board', exact: true }).click();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  const before = await (await request.get('/api/board')).json();
  expect(before.tasks.find((task: { title: string }) => task.title === title)).toMatchObject({ description: 'Original 中文 description', status: 'in_review' });
  for (const url of ['/?lang=zh-CN', '/', '/?lang=unknown']) {
    await page.goto(url);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('tab')).toHaveText(['任务管理', '共享面板']);
    await expect(page.getByRole('button', { name: /新建任务|创建任务/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `查看任务 ${title}`, exact: true })).toBeVisible();
  }
  expect(await (await request.get('/api/board')).json()).toEqual(before);
  expect(creates).toEqual([]);
});
