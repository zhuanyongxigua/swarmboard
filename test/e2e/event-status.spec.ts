// Verify visible event-worker status and actionable failures without starting a model.
import { test, expect } from '@playwright/test';
test('shows registered event sessions and their blocker while retaining three board tabs', async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', owner: { pid: 123 }, error: '', workers: [{ id: 'worker', name: 'Project builder', enabled: false, status: 'uncertain', error: 'Inspect the bound session before retrying' }] } }));
  await page.goto('/');
  await expect(page.getByRole('region', { name: '协作概览', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Inspect the bound session before retrying');
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '协作环境', '共享面板']);
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
  await page.goto('/'); await expect(page.getByRole('region', { name: '协作概览', exact: true })).toBeVisible();
  const before = await page.locator('.task-card').count();
  await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
  // Maintenance remains an authenticated API operation rather than a permanent UI stop action.
  await page.evaluate(async () => { const r = await fetch('/api/pool/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, enabled: false }) }); if (!r.ok) throw Error('Synthetic stop failed'); });
  await page.getByRole('button', { name: '刷新面板', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复协作', exact: true })).toBeVisible();
  expect(pool.state).toBe('stopping');
  await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '恢复协作', exact: true }).click();
  expect(pool.state).toBe('ready');
  expect(commands).toEqual([{ expectedVersion: 1, enabled: false }, { expectedVersion: 2, enabled: true }]);
  await expect(page.locator('.task-card')).toHaveCount(before);
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '协作环境', '共享面板']);
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
  expect(await page.evaluate(async () => (await fetch('/api/runtime')).json())).toMatchObject({ activity: { members: 3, running: 0 } });
  await expect(page.getByRole('region', { name: '协作概览', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).not.toContainText('仅内部协作');
  await expect(page.getByRole('status')).toContainText('下次空闲检查');
  const before = await page.locator('.task-card').count();
  activity.state = 'running'; activity.running = 2; activity.idle = 1; activity.watchdog.nextWakeAt = null;
  await page.getByRole('button', { name: '刷新面板' }).click();
  expect(await page.evaluate(async () => (await fetch('/api/runtime')).json())).toMatchObject({ activity: { members: 3, running: 2 } });
  await expect(page.getByRole('status')).not.toContainText('下次空闲检查');
  activity.state = 'attention'; activity.running = 0; activity.idle = 3; activity.watchdog.state = 'attention'; activity.watchdog.attempts = 2;
  await page.getByRole('button', { name: '刷新面板' }).click();
  await expect(page.getByRole('alert')).toContainText('两次空闲检查后目标仍未推进');
  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(commands).toEqual([{ expectedVersion: 7, enabled: true }]);
  await expect(page.locator('.task-card')).toHaveCount(before);
});

test('grows the same organization with its current version and shows durable CI waiting or failure', async ({ page }) => {
  const pool = { id:'same-organization', workspacePath:'/synthetic/project', taskIds:['human-goal'], size:3, maxSize:5, enabled:true, version:8, state:'active', error:'' };
  const ciWatches = [{id:'ci',pipelineId:100,sha:'a'.repeat(40),state:'watching',error:''}];
  const commands: unknown[]=[];
  await page.route('**/api/runtime',route=>route.fulfill({json:{mode:'events',workers:[],error:'',pool,ciWatches}}));
  await page.route('**/api/pool/configure',route=>{
    commands.push(route.request().postDataJSON());pool.size++;pool.version++;
    return route.fulfill({json:pool});
  });
  await page.goto('/');await expect(page.getByRole('status')).toContainText('等待 CI 结果，完成后通知全体成员');
  await page.getByRole('button',{name:'增加成员',exact:true}).click();
  expect(commands).toEqual([{workspacePath:'/synthetic/project',taskIds:['human-goal'],size:4,maxSize:5,expectedVersion:8}]);
  ciWatches[0].state='error';ciWatches[0].error='GitLab lookup needs attention';
  await page.getByRole('button',{name:'刷新面板'}).click();await expect(page.getByRole('alert')).toContainText('CI #100: GitLab lookup needs attention');
  await expect(page.getByRole('status')).not.toContainText('等待 CI 结果，完成后通知全体成员');
});

test('shows all shared-goal participants instead of a single assignee', async ({ page, request }) => {
  const post=async(path:string,data:unknown)=>{const response=await request.post(path,{data});expect(response.ok()).toBe(true);return response.json();};
  const a=await post('/api/agents',{name:'Shared peer A'}),b=await post('/api/agents',{name:'Shared peer B'});
  const task=await post('/api/tasks',{title:'Multiple peers on one goal'});
  for(const agent of [a,b])await post('/api/entries',{agentId:agent.id,taskId:task.id,kind:'CLAIM',summary:'Independent contribution'});
  await page.goto('/');const card=page.locator('.task-card').filter({hasText:task.title});await expect(card).toContainText('参与者 2');
  await page.getByRole('button',{name:'查看任务 '+task.title,exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Shared peer A');await expect(page.getByRole('dialog')).toContainText('Shared peer B');
});

for (const { language, maxSize, label, hint } of [
  { language: 'zh-CN', maxSize: 10, label: '增加成员', hint: '已达成员上限（10 人）' },
  { language: 'en', maxSize: 12, label: 'Add member', hint: 'Member limit reached (12)' },
]) test(`explains the configured member limit on hover and keyboard focus (${language})`, async ({ page }, testInfo) => {
  const pool = { id: 'same-pool', workspacePath: '/synthetic/project', taskIds: [], size: maxSize - 1, maxSize, enabled: true, version: 8, state: 'active', error: '' };
  const commands: unknown[] = [];
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', workers: [], error: '', pool } }));
  await page.route('**/api/pool/configure', route => {
    const request = route.request().postDataJSON(); commands.push(request);
    pool.size = request.size; pool.version++;
    return route.fulfill({ json: pool });
  });
  await page.goto(`/?lang=${language}`);
  const button = page.getByRole('button', { name: label, exact: true });
  await expect(button).toBeEnabled();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await button.click();
  await expect(button).toBeDisabled();
  expect(commands).toEqual([{ workspacePath: pool.workspacePath, taskIds: [], size: maxSize, maxSize, expectedVersion: 8 }]);
  const control = button.locator('..');
  await control.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveText(hint);
  await expect(button).toHaveAccessibleDescription(hint);
  await page.screenshot({ path: testInfo.outputPath('member-limit-tooltip.png') });
  await page.getByRole('heading', { name: 'Swarmboard', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.getByRole('button', { name: language === 'en' ? 'Refresh board' : '刷新面板' }).focus();
  await page.keyboard.press('Tab');
  await expect(control).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tooltip')).toBeHidden();
  expect(commands).toHaveLength(1);
});
