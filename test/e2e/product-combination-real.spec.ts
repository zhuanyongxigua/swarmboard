// Verify the three reviewed product features coexist through real HTTP and
// disposable SQLite, while explicitly forbidding native or model dispatch.
import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { WorkerPool } from '../../src/worker-pool.js';
import { startServer } from '../../src/app.js';

test('progress, preferences and capacity controls coexist without losing each other’s data', async ({ page, request }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'swarmboard-product-combination-'));
  const dbPath = join(directory, 'board.sqlite');
  const store = new Store(dbPath);
  let sessionAttempts = 0;
  const runtime = new EventRuntime(store, {
    databasePath: dbPath, serverEntry: 'unused', debounceMs: 60000,
    adapter: () => { sessionAttempts++; throw new Error('Combination fixture must not dispatch a session'); },
  });
  const pool = runtime.configurePool({ workspacePath: directory, size: 2 });
  const memberIds = ['first', 'second'].map(name => {
    const workspacePath = join(directory, name); mkdirSync(workspacePath);
    const worker = runtime.workers.register({ name, workspacePath });
    runtime.workers.save({ ...worker, poolId: pool.id });
    store.registerAgent({ agentId: worker.id, name });
    return worker.id;
  });
  runtime.workers.savePool({ ...pool, memberIds });
  const server = await startServer({ port: 0, store, runtime });
  try {
    const resourceResponse = await request.post(`${server.url}/api/resources`, { data: { name: 'Synthetic combined resource', accessNotes: 'Synthetic sharing agreement' } });
    expect(resourceResponse.ok()).toBe(true);
    const resource = await resourceResponse.json();
    const taskResponse = await request.post(`${server.url}/api/tasks`, { data: { title: 'Synthetic combined task' } });
    expect(taskResponse.ok()).toBe(true);
    let task = await taskResponse.json();
    const started = await request.patch(`${server.url}/api/tasks/${task.id}`, { data: { expectedVersion: task.version, status: 'in_progress' } });
    expect(started.ok()).toBe(true); task = await started.json();
    const written = await request.patch(`${server.url}/api/tasks/${task.id}/progress`, { data: { expectedVersion: task.version, progress: { percent: 35, state: 'waiting', phase: 'Synthetic review', verified: 'Synthetic verified evidence', remaining: 'Synthetic remaining check' } } });
    expect(written.ok()).toBe(true); task = await written.json();
    const originalProgress = task.progress;
    const readTask = async () => {
      const board = await (await request.get(`${server.url}/api/board`)).json();
      return board.tasks.find((item: { id: string }) => item.id === task.id);
    };

    await page.goto(server.url);
    const writeOverview = async () => {
      const view = await (await request.get(`${server.url}/api/overview`)).json();
      const prefs = await (await request.get(`${server.url}/api/preferences`)).json();
      const response = await request.post(`${server.url}/api/overview`, { data: {
        expectedVersion: view.record?.version ?? 0, factsRevision: view.facts.revision,
        preferencesVersion: prefs.version, parts: [
          { kind: 'text', text: 'Synthetic overview chosen for this fixture' },
          { kind: 'fact', factId: 'native.members' }, { kind: 'fact', factId: 'external.model' },
        ],
      } });
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ status: 'current', record: { authorId: 'human-host' } });
      await page.getByRole('button', { name: '刷新面板', exact: true }).click();
    };
    await writeOverview();
    const overview = page.getByRole('region', { name: '协作概览', exact: true });
    await expect(overview).toContainText('Synthetic overview chosen for this fixture');
    await expect(overview.locator('strong')).toHaveText(['2', '未知']);
    await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
    const card = page.locator(`[data-card-id="${task.id}"]`);
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
    await expect(card).toContainText('等待中');
    await card.locator('.task-progress-trigger').focus();
    await expect(page.getByRole('tooltip')).toContainText('Synthetic verified evidence');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '查看任务 Synthetic combined task', exact: true }).click();
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Synthetic combined task');
    await page.getByRole('button', { name: '关闭编辑窗口', exact: true }).click();
    await expect(page.locator('button button')).toHaveCount(0);

    await page.getByRole('tab', { name: '协作环境', exact: true }).click();
    await expect(page.getByRole('button', { name: '查看资源 Synthetic combined resource', exact: true })).toBeVisible();
    await page.getByLabel('偏好内容', { exact: true }).fill('Synthetic user expectation');
    await page.getByLabel('内容来源', { exact: true }).selectOption('main-chat-relay');
    await page.getByRole('button', { name: '保存偏好', exact: true }).click();
    await expect(page.getByLabel('当前保存的偏好')).toContainText('v1');
    await expect(overview).toContainText('Synthetic overview chosen for this fixture');
    await expect(overview).not.toHaveAttribute('data-overview-state', 'current');
    await expect(overview).not.toContainText('上次概览');
    await expect(overview.locator('strong')).toHaveText(['2', '未知']);
    const preferences = await (await request.get(`${server.url}/api/preferences`)).json();
    expect(preferences).toMatchObject({ text: 'Synthetic user expectation', source: 'main-chat-relay', version: 1 });

    await page.getByRole('button', { name: '减少成员', exact: true }).click();
    expect(await (await request.get(`${server.url}/api/runtime`)).json()).toMatchObject({ activity: { members: 1, running: 0 } });
    await expect(page.getByRole('button', { name: '减少成员', exact: true })).toBeDisabled();
    expect(runtime.workers.list().filter(worker => worker.retirement?.state === 'retired')).toHaveLength(1);
    expect((await readTask()).progress).toEqual(originalProgress);
    expect(await (await request.get(`${server.url}/api/preferences`)).json()).toEqual(preferences);
    await page.getByRole('button', { name: '增加成员', exact: true }).click();
    await expect.poll(() => runtime.workers.pool()!.size).toBe(2);
    new WorkerPool(runtime.workers, store, dbPath).ensureMembers(runtime.workers.pool()!);
    await page.getByRole('button', { name: '刷新面板', exact: true }).click();
    expect(await (await request.get(`${server.url}/api/runtime`)).json()).toMatchObject({ activity: { members: 2, running: 0 } });
    await writeOverview();
    await expect(overview.locator('strong')).toHaveText(['2', '未知']);
    expect(runtime.workers.pool()!.memberIds).toEqual(expect.arrayContaining(memberIds));
    await page.screenshot({ path: testInfo.outputPath('combination-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.url}/?lang=en`);
    await expect(page.getByRole('region', { name: 'Collaboration overview', exact: true }).locator('strong')).toHaveText(['2', 'Unknown']);
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
    await expect(card).toContainText('Waiting');
    await expect(page.getByRole('button', { name: 'Reduce member', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('tab', { name: 'Collaboration environment', exact: true }).click();
    await expect(page.getByLabel('Preference text', { exact: true })).toHaveValue('Synthetic user expectation');
    await expect(page.getByRole('button', { name: 'View resource Synthetic combined resource', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear saved preferences', exact: true }).click();
    await expect(page.getByLabel('Preference text', { exact: true })).toHaveValue('');
    const previousOverview = page.getByRole('region', { name: 'Collaboration overview', exact: true });
    await expect(previousOverview).toContainText('Synthetic overview chosen for this fixture');
    await expect(previousOverview).not.toHaveAttribute('data-overview-state', 'current');
    await expect(previousOverview).not.toContainText('Previous overview:');
    await expect(previousOverview.locator('strong')).toHaveText(['2', 'Unknown']);
    expect(await (await request.get(`${server.url}/api/preferences`)).json()).toMatchObject({ text: '', version: 2 });
    expect((await readTask()).progress).toEqual(originalProgress);
    const board = await (await request.get(`${server.url}/api/board`)).json();
    expect(board.resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({ name: resource.name, accessNotes: 'Synthetic sharing agreement' });
    expect(runtime.workers.list()).toHaveLength(2);
    expect(sessionAttempts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('combination-mobile.png'), fullPage: true });
  } finally {
    await test.step('Close test-owned clients and HTTP connections', async () => {
      await page.close(); await request.dispose();
      const closing = server.close();
      // Accepted preconnect sockets can outlive navigation; only this fixture's
      // connections are closed after its browser and API clients have finished.
      server.server.closeAllConnections();
      await closing;
    });
    await runtime.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
