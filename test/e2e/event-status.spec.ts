// Verify visible event-worker status and actionable failures without starting a model.
import { test, expect } from '@playwright/test';
test('shows registered event sessions and their blocker while retaining three board tabs', async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', owner: { pid: 123 }, error: '', workers: [{ id: 'worker', name: 'Project builder', enabled: false, status: 'uncertain', error: 'Inspect the bound session before retrying' }] } }));
  await page.goto('/');
  await expect(page.getByText('事件协作 · 0 个工作会话')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Inspect the bound session before retrying');
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '资源池', '共享面板']);
});

test('human pool stop and resume preserve the task board and show the confirmed lifecycle', async ({ page }) => {
  let pool = { size: 3, enabled: true, version: 1, state: 'active', error: '' };
  const commands: unknown[] = [];
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: '', pool } }));
  await page.route('**/api/pool/control', route => {
    const request = route.request().postDataJSON(); commands.push(request);
    pool = { ...pool, enabled: request.enabled, version: pool.version + 1, state: request.enabled ? 'ready' : 'stopping' };
    return route.fulfill({ json: pool });
  });
  await page.goto('/'); await expect(page.getByRole('status')).toContainText('自协作池');
  const before = await page.locator('.task-card').count();
  await page.getByRole('button', { name: '停止协作', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复协作', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('正在安全停止');
  await page.getByRole('button', { name: '恢复协作', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('等待任务');
  expect(commands).toEqual([{ expectedVersion: 1, enabled: false }, { expectedVersion: 2, enabled: true }]);
  await expect(page.locator('.task-card')).toHaveCount(before);
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '资源池', '共享面板']);
});
