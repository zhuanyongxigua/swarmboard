// Verify visible event-worker status and actionable failures without starting a model.
import { test, expect } from '@playwright/test';
test('shows registered event sessions and their blocker while retaining three board tabs', async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', owner: { pid: 123 }, error: '', workers: [{ id: 'worker', name: 'Project builder', enabled: false, status: 'uncertain', error: 'Inspect the bound session before retrying' }] } }));
  await page.goto('/');
  await expect(page.getByText('事件协作 · 0 个工作会话')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Inspect the bound session before retrying');
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '资源池', '共享面板']);
});
