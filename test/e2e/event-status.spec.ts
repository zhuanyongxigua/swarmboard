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

test('distinguishes idle members from executing peers and supports bounded recovery retry', async ({ page }) => {
  const pool = { id: 'pool', size: 3, enabled: true, version: 7, state: 'active', error: '' };
  const activity = { members: 3, running: 0, idle: 3, state: 'idle', executionMode: 'internal-only', watchdog: { state: 'watching', attempts: 0, nextWakeAt: '2026-10-17T20:00:00Z' as string | null } };
  const commands: unknown[] = [];
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: '', pool, activity } }));
  await page.route('**/api/pool/control', route => {
    commands.push(route.request().postDataJSON()); pool.version++; activity.state = 'idle'; activity.watchdog.state = 'watching'; activity.watchdog.attempts = 0;
    return route.fulfill({ json: pool });
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('3 个成员 · 0 个正在执行');
  await expect(page.getByRole('status')).toContainText('有未完成目标，当前空闲');
  await expect(page.getByRole('status')).toContainText('仅内部协作');
  await expect(page.getByRole('status')).toContainText('下次空闲检查');
  const before = await page.locator('.task-card').count();
  activity.state = 'running'; activity.running = 2; activity.idle = 1; activity.watchdog.nextWakeAt = null;
  await page.getByRole('button', { name: '刷新面板' }).click();
  await expect(page.getByRole('status')).toContainText('2 个正在执行 · 协作中');
  await expect(page.getByRole('status')).not.toContainText('下次空闲检查');
  activity.state = 'attention'; activity.running = 0; activity.idle = 3; activity.watchdog.state = 'attention'; activity.watchdog.attempts = 2;
  await page.getByRole('button', { name: '刷新面板' }).click();
  await expect(page.getByRole('alert')).toContainText('两次空闲检查后目标仍未推进');
  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(commands).toEqual([{ expectedVersion: 7, enabled: true }]);
  await expect(page.locator('.task-card')).toHaveCount(before);
});
