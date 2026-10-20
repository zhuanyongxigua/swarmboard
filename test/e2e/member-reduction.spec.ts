import { refreshBoard } from './settings-helpers.js';
// Verify capacity controls against synthetic runtime responses, without dispatching a worker.
import { test, expect, type Page } from '@playwright/test';

function fixture(size = 2) {
  return {
    mode: 'events', error: '', workers: [],
    pool: { id: 'isolated-pool', workspacePath: '/synthetic/project', taskIds: ['synthetic-goal'], size, minSize: 1, maxSize: 5, version: 8, enabled: true, state: 'active', error: '' },
    activity: { members: size, running: 0, idle: size, draining: 0, state: 'idle', executionMode: 'internal-only', watchdog: { state: 'inactive', attempts: 0, nextWakeAt: null } },
  };
}
async function runtime(page: Page, state: ReturnType<typeof fixture>) {
  await page.route('**/api/runtime', route => route.fulfill({ json: state }));
}

// Counts are authoritative runtime evidence, not a requirement on AI-selected wording.
async function expectActualCount(page: Page, members: number, running?: number) {
  const actual = await page.evaluate(async () => (await fetch('/api/runtime')).json());
  expect(actual.activity.members).toBe(members);
  if (running !== undefined) expect(actual.activity.running).toBe(running);
}

test('reduces one idle member with CAS, then permits adding a member again', async ({ page }) => {
  const state = fixture(); const commands: Record<string, unknown>[] = [];
  await runtime(page, state);
  await page.route('**/api/pool/reduce', route => {
    commands.push(route.request().postDataJSON());
    state.pool.size--; state.pool.version++; state.activity.members--; state.activity.idle--;
    return route.fulfill({ json: state.pool });
  });
  await page.route('**/api/pool/configure', route => {
    commands.push(route.request().postDataJSON());
    state.pool.size++; state.pool.version++; state.activity.members++; state.activity.idle++;
    return route.fulfill({ json: state.pool });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '减少成员', exact: true }).click();
  await expectActualCount(page, 1, 0);
  await expect(page.getByRole('status')).toContainText('已减少一名成员。');
  expect(commands[0]).toEqual({ expectedVersion: 8, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  await page.getByRole('button', { name: '增加成员', exact: true }).click();
  await expectActualCount(page, 2, 0);
  expect(commands[1]).toMatchObject({ expectedVersion: 9, size: 2 });
  expect(commands).toHaveLength(2);
});

test('keeps a busy member in the actual count while retirement is pending, including after reload', async ({ page }) => {
  const state = fixture(); state.activity.running = 2; state.activity.idle = 0;
  let calls = 0;
  await runtime(page, state);
  await page.route('**/api/pool/reduce', route => {
    calls++; state.pool.size--; state.pool.version++; state.activity.draining = 1;
    return route.fulfill({ json: state.pool });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '减少成员', exact: true }).click();
  await expectActualCount(page, 2, 2);
  await expect(page.getByRole('status')).toContainText('1 个正在退出');
  await expect(page.getByRole('status')).toContainText('正在等待成员安全收尾或核清，实际人数尚未减少。');
  await expect(page.getByRole('status')).not.toContainText('已减少一名成员。');
  await page.reload();
  await expectActualCount(page, 2, 2);
  await expect(page.getByRole('status')).toContainText('1 个正在退出');
  state.activity.members = 1; state.activity.running = 0; state.activity.draining = 0;
  await refreshBoard(page);
  await expectActualCount(page, 1, 0);
  await expect(page.getByRole('status')).not.toContainText('个正在退出');
  expect(calls).toBe(1);
});

for (const copy of [
  { lang: 'zh-CN', label: '减少成员', hint: '至少保留 1 名成员', paused: '协作已停止，暂不可调整成员。' },
  { lang: 'en', label: 'Reduce member', hint: 'Keep at least 1 member', paused: 'Collaboration is stopped. Member changes are unavailable.' },
]) test(`explains the lower limit and stopped state on hover and keyboard focus (${copy.lang})`, async ({ page }) => {
  const state = fixture(1); await runtime(page, state); await page.goto(`/?lang=${copy.lang}`);
  const button = page.getByRole('button', { name: copy.label, exact: true });
  await expect(button).toBeDisabled();
  const control = button.locator('..');
  await control.hover();
  await expect(page.getByRole('tooltip')).toHaveText(copy.hint);
  await expect(button).toHaveAccessibleDescription(copy.hint);
  await page.getByRole('heading', { name: 'Swarmboard', exact: true }).hover();
  await control.focus();
  await expect(page.getByRole('tooltip')).toHaveText(copy.hint);
  state.pool.size = 2; state.activity.members = 2; state.pool.enabled = false;
  await refreshBoard(page);
  await expect(page.getByRole('button', { name: /^(停止协作|恢复协作|Stop collaboration|Resume collaboration)$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: copy.lang === 'en' ? 'Add member' : '增加成员', exact: true })).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(copy.paused);
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).focus();
  await page.keyboard.press('Tab');
  await expect(control).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(copy.paused);
});

test('does not retry a conflicting or unconfirmed reduction and refreshes the authoritative count', async ({ page }) => {
  const state = fixture(3); let calls = 0;
  await runtime(page, state);
  await page.route('**/api/pool/reduce', route => {
    calls++; state.pool.version++;
    return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: 'stale version' } } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '减少成员', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('内容已被其他参与者更新');
  await expectActualCount(page, 3);
  expect(calls).toBe(1);
  await page.unroute('**/api/pool/reduce');
  await page.route('**/api/pool/reduce', route => { calls++; return route.abort('failed'); });
  await page.getByRole('button', { name: '减少成员', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('减少结果尚未确认，请刷新核对实际人数后再操作。');
  await expect(page.getByRole('status')).not.toContainText('已减少一名成员。');
  expect(calls).toBe(2);
});

test('serializes capacity changes and keeps controls usable on a narrow board', async ({ page }, testInfo) => {
  const state = fixture(3); await runtime(page, state);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  await page.route('**/api/pool/reduce', async route => {
    calls++; await pending;
    state.pool.size--; state.pool.version++; state.activity.members--; state.activity.idle--;
    await route.fulfill({ json: { pool: state.pool, requestId: route.request().postDataJSON().requestId } });
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/?lang=en');
  const reduce = page.getByRole('button', { name: 'Reduce member', exact: true });
  await reduce.click();
  await expect(reduce).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop collaboration', exact: true })).toHaveCount(0);
  expect(calls).toBe(1); finish();
  await expect(reduce).toBeEnabled();
  await expectActualCount(page, 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('member-controls-mobile.png') });
});

test('the browser retires through real HTTP and SQLite and retains the original identity after adding again', async ({ page }, testInfo) => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../../src/store.js');
  const { EventRuntime } = await import('../../src/event-runtime.js');
  const { WorkerPool } = await import('../../src/worker-pool.js');
  const { startServer } = await import('../../src/app.js');
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-browser-capacity-'));
  const dbPath = join(dir, 'board.sqlite'); const store = new Store(dbPath);
  let sessionAttempts = 0;
  // No watchers or scans are started. Defer automatic notifications beyond this
  // test's deadline and reject any unexpected session attempt without a model.
  const runtime = new EventRuntime(store, { databasePath: dbPath, serverEntry: 'unused', debounceMs: 60000,
    adapter: () => { sessionAttempts++; throw new Error('browser capacity fixture must not open a session'); } });
  const pool = runtime.configurePool({ workspacePath: dir, size: 2 });
  const ids = ['first', 'second'].map(name => {
    const workspacePath = join(dir, name); mkdirSync(workspacePath);
    const worker = runtime.workers.register({ name, workspacePath });
    runtime.workers.save({ ...worker, poolId: pool.id }); store.registerAgent({ agentId: worker.id, name });
    return worker.id;
  });
  runtime.workers.savePool({ ...pool, memberIds: ids });
  const server = await startServer({ port: 0, store, runtime });
  try {
    await page.goto(server.url);
    await expectActualCount(page, 2, 0);
    await page.getByRole('button', { name: '减少成员', exact: true }).click();
    await expectActualCount(page, 1, 0);
    await expect(page.getByRole('status')).toContainText('已减少一名成员。');
    const retired = runtime.workers.list().find(worker => worker.retirement?.state === 'retired');
    expect(retired).toBeDefined(); expect(runtime.workers.list()).toHaveLength(2);
    await page.reload();
    await expect(page.getByRole('button', { name: '减少成员', exact: true })).toBeDisabled();
    await expectActualCount(page, 1);
    await page.getByRole('button', { name: '增加成员', exact: true }).click();
    await expect.poll(() => runtime.workers.pool()!.size).toBe(2);
    // Run only capacity preparation, not event dispatch or a native session.
    new WorkerPool(runtime.workers, store, dbPath).ensureMembers(runtime.workers.pool()!);
    await refreshBoard(page);
    await expectActualCount(page, 2, 0);
    expect(runtime.workers.pool()!.memberIds).toEqual(expect.arrayContaining(ids));
    expect(runtime.workers.list()).toHaveLength(2); expect(sessionAttempts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('member-controls-real-http.png') });
  } finally {
    await test.step('Close capacity fixture browser and HTTP connections', async () => {
      await page.close();
      const closing = server.close();
      // Preconnect sockets can outlive navigation. Stop accepting first, then
      // close only this disposable fixture's connections after its browser.
      server.server.closeAllConnections();
      await closing;
    });
    await test.step('Close capacity fixture runtime and SQLite', async () => {
      await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    });
  }
});
