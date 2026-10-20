// Check the single settings surface against explicit configuration responses;
// model execution and the user's real collaboration database remain outside this fixture.
import { test, expect } from '@playwright/test';

for (const surface of [
  { name: 'desktop', width: 1100, height: 800, hasTouch: false },
  { name: 'touch desktop', width: 1100, height: 800, hasTouch: true },
  { name: 'touch mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`settings button stays circular on ${surface.name}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: surface.width, height: surface.height }, hasTouch: surface.hasTouch });
    try {
      const page = await context.newPage();
      await page.goto(baseURL!);
      const button = page.getByRole('button', { name: '设置', exact: true });
      await expect(button).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(surface.hasTouch);
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
      expect(box!.width).toBeGreaterThanOrEqual(surface.hasTouch ? 44 : 34);
      await expect(button).toHaveCSS('border-radius', '50%');
      const gear = await button.locator('svg path').evaluate(element => {
        const bounds = (element as SVGGraphicsElement).getBBox();
        return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
      });
      expect(Math.abs(gear.width - gear.height)).toBeLessThan(0.1);
      expect(gear.x + gear.width / 2).toBeCloseTo(12);
      expect(gear.y + gear.height / 2).toBeCloseTo(12);
      await button.click();
      await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
}

test('settings replaces connection controls and the environment tab; prompts save independently without legacy resource controls', async ({ page }, info) => {
  const resource = { id: 'legacy', name: 'Legacy resource', description: 'Original description', kind: 'machine', capabilities: ['build'], accessNotes: 'Coordinate first', version: 3 };
  await page.route('**/api/board', route => route.fulfill({ json: { tasks: [], resources: [resource], agents: [], usages: [], entries: [], cursor: 0 } }));
  const prompt = (text: string) => ({ boardId: 'synthetic', text, version: 1, source: 'human-input', updatedAt: null });
  let system = prompt('Original preference'); let user = prompt('User context');
  const writes: string[] = [];
  for (const [url, kind] of [['preferences', 'system'], ['user-prompt', 'user']]) {
    await page.route(`**/api/${url}`, route => {
      const current = kind === 'system' ? system : user;
      if (route.request().method() === 'GET') return route.fulfill({ json: current });
      const input = route.request().postDataJSON(); expect(input.expectedVersion).toBe(current.version); writes.push(kind);
      const next = { ...current, text: input.text, source: input.source, version: current.version + 1 };
      if (kind === 'system') system = next; else user = next;
      return route.fulfill({ json: next });
    });
  }
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '共享面板']);
  await expect(page.getByText('已连接', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: '刷新面板' })).toHaveCount(0);
  const settings = page.getByRole('button', { name: '设置', exact: true }); await settings.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Original preference');
  await dialog.getByLabel('用户提示词内容', { exact: true }).fill('New user context');
  await dialog.getByRole('button', { name: '保存用户提示词', exact: true }).click();
  await expect(dialog.getByText('用户提示词已保存。', { exact: true })).toBeVisible(); expect(system.text).toBe('Original preference');
  await dialog.getByRole('button', { name: '清空系统提示词', exact: true }).click();
  await expect(dialog.getByLabel('系统提示词内容', { exact: true })).toHaveValue(''); expect(user.text).toBe('New user context');
  await expect(dialog.locator('.legacy-resources, .resource-grid')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /查看资源|编辑资源/ })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(settings).toBeFocused();
  await settings.click(); await expect(page.getByLabel('用户提示词内容', { exact: true })).toHaveValue('New user context');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('settings-mobile.png'), fullPage: true }); expect(writes).toEqual(['user', 'system']);
});

test('capacity save adopts the confirmed version without a false conflict', async ({ page }) => {
  const pool = { id: 'synthetic', workspacePath: '/synthetic', taskIds: [], size: 4, minSize: 2, maxSize: 8, version: 3, enabled: true, state: 'active', error: '' };
  let posted = false; const calls: unknown[] = [];
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', pool: posted ? { ...pool, minSize: 1, maxSize: 5, version: 4 } : pool, workers: [] } }));
  await page.route('**/api/overview', route => route.fulfill({ json: { status: 'missing', reason: null, record: null, facts: { revision: '', observedAt: new Date().toISOString(), available: false, items: [] } } }));
  await page.route('**/api/preferences', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/user-prompt', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/pool/capacity', route => { posted = true; calls.push(route.request().postDataJSON()); return route.fulfill({ json: { ...pool, minSize: 1, maxSize: 5, version: 4 } }); });
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('最少成员', { exact: true }).fill('1'); await page.getByLabel('最多成员', { exact: true }).fill('5');
  await page.getByRole('button', { name: '保存成员上下限' }).click();
  await expect(page.getByText('成员上下限已保存。人数调整将在安全边界完成。', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '草稿已保留' })).toHaveCount(0);
  expect(calls).toEqual([{ minSize: 1, maxSize: 5, expectedVersion: 3 }]);
});

test('capacity save reports a saved value separately from a failed refresh', async ({ page }) => {
  const pool = { id: 'synthetic', workspacePath: '/synthetic', taskIds: [], size: 4, minSize: 2, maxSize: 8, version: 3, enabled: true, state: 'active', error: '' };
  let posted = false;
  await page.route('**/api/runtime', route => posted
    ? route.fulfill({ status: 503, json: { error: { code: 'RUNTIME_UNAVAILABLE', message: 'Synthetic runtime read failed' } } })
    : route.fulfill({ json: { mode: 'events', pool, workers: [] } }));
  await page.route('**/api/preferences', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/user-prompt', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/pool/capacity', route => { posted = true; return route.fulfill({ json: { ...pool, minSize: 1, maxSize: 5, version: 4 } }); });
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('最少成员', { exact: true }).fill('1'); await page.getByLabel('最多成员', { exact: true }).fill('5');
  await page.getByRole('button', { name: '保存成员上下限' }).click();
  await expect(page.getByText('成员上下限已保存。人数调整将在安全边界完成。', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '最新状态读取失败' })).toBeVisible();
  await expect(page.getByText('成员配置未保存，请重试。', { exact: true })).toHaveCount(0);
});

test('capacity reuses the confirmed POST version when the refresh failed', async ({ page }) => {
  const pool = { id: 'synthetic', workspacePath: '/synthetic', taskIds: [], size: 4, minSize: 2, maxSize: 8, version: 3, enabled: true, state: 'active', error: '' };
  let posts = 0; const calls: Record<string, unknown>[] = [];
  await page.route('**/api/runtime', route => posts > 0
    ? route.fulfill({ status: 503, json: { error: { code: 'RUNTIME_UNAVAILABLE', message: 'Synthetic runtime read failed' } } })
    : route.fulfill({ json: { mode: 'events', pool, workers: [] } }));
  await page.route('**/api/preferences', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/user-prompt', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/pool/capacity', route => {
    calls.push(route.request().postDataJSON()); posts++;
    if (posts === 1) return route.fulfill({ json: { ...pool, minSize: 1, maxSize: 5, version: 4 } });
    return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: 'conflict' } } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('最少成员', { exact: true }).fill('1'); await page.getByLabel('最多成员', { exact: true }).fill('5');
  await page.getByRole('button', { name: '保存成员上下限' }).click();
  await expect(page.getByText('成员上下限已保存。人数调整将在安全边界完成。', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '最新状态读取失败' })).toBeVisible();
  await page.getByLabel('最多成员', { exact: true }).fill('6');
  await page.getByRole('button', { name: '保存成员上下限' }).click();
  expect(calls[1]).toMatchObject({ minSize: 1, maxSize: 6, expectedVersion: 4 });
  await expect(page.getByRole('alert').filter({ hasText: '草稿已保留' })).toBeVisible();
  await expect(page.getByLabel('最多成员', { exact: true })).toHaveValue('6');
});

test('capacity validates bounds, uses the current revision, and preserves the draft after a conflict', async ({ page }) => {
  let pool = { id: 'synthetic', workspacePath: '/synthetic', taskIds: [], size: 4, minSize: 2, maxSize: 8, version: 3, enabled: true, state: 'active', error: '' };
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', pool, workers: [] } }));
  await page.route('**/api/preferences', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  await page.route('**/api/user-prompt', route => route.fulfill({ json: { boardId: 'fixture', text: '', version: 0, source: null, updatedAt: null } }));
  const inputs: Record<string, unknown>[] = [];
  await page.route('**/api/pool/capacity', route => {
    inputs.push(route.request().postDataJSON());
    pool = { ...pool, version: 4, maxSize: 6 };
    return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: 'conflict' } } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('最少成员', { exact: true })).toHaveValue('2');
  await page.getByLabel('最少成员', { exact: true }).fill('9'); await page.getByRole('button', { name: '保存成员上下限' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '最少成员不能大于最多成员' })).toBeVisible(); expect(inputs).toHaveLength(0);
  await page.getByLabel('最少成员', { exact: true }).fill('1'); await page.getByLabel('最多成员', { exact: true }).fill('5');
  await page.getByRole('button', { name: '保存成员上下限' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '草稿已保留' })).toBeVisible();
  expect(inputs).toHaveLength(1); expect(inputs[0]).toMatchObject({ minSize: 1, maxSize: 5, expectedVersion: 3 });
  await expect(page.getByLabel('最多成员', { exact: true })).toHaveValue('5');
  await expect(page.getByRole('button', { name: '保存成员上下限' })).toBeDisabled();
});

test('settings persist both prompt fields and capacity through real HTTP and SQLite without model dispatch', async ({ page, request }) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { Store } = await import('../../src/store.js'); const { EventRuntime } = await import('../../src/event-runtime.js');
  const { startServer } = await import('../../src/app.js');
  const directory = mkdtempSync(join(tmpdir(), 'settings-real-')), dbPath = join(directory, 'board.sqlite');
  const store = new Store(dbPath); let attempts = 0;
  const runtime = new EventRuntime(store, { databasePath: dbPath, serverEntry: 'unused', debounceMs: 600000,
    adapter: () => { attempts++; throw Error('No model sessions in settings fixture'); } });
  runtime.configurePool({ workspacePath: directory, size: 2, maxSize: 8 });
  const server = await startServer({ port: 0, store, runtime });
  try {
    await page.goto(server.url); await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('最少成员', { exact: true }).fill('2'); await page.getByLabel('最多成员', { exact: true }).fill('3');
    await page.getByRole('button', { name: '保存成员上下限' }).click();
    await expect(page.getByText('成员上下限已保存。人数调整将在安全边界完成。', { exact: true })).toBeVisible();
    await page.getByLabel('系统提示词内容', { exact: true }).fill('Synthetic system configuration');
    await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
    await expect(page.getByText('系统提示词已保存。', { exact: true })).toBeVisible();
    await page.getByLabel('用户提示词内容', { exact: true }).fill('Synthetic user configuration');
    await page.getByRole('button', { name: '保存用户提示词', exact: true }).click();
    await expect(page.getByText('用户提示词已保存。', { exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('最少成员', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('最多成员', { exact: true })).toHaveValue('3');
    await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Synthetic system configuration');
    await expect(page.getByLabel('用户提示词内容', { exact: true })).toHaveValue('Synthetic user configuration');
    await page.getByRole('button', { name: '清空用户提示词', exact: true }).click();
    await expect(page.getByLabel('用户提示词内容', { exact: true })).toHaveValue('');
    expect(await (await request.get(server.url + '/api/preferences')).json()).toMatchObject({ text: 'Synthetic system configuration', version: 1 });
    expect(await (await request.get(server.url + '/api/user-prompt')).json()).toMatchObject({ text: '', version: 2 });
    expect(runtime.workers.pool()).toMatchObject({ minSize: 2, maxSize: 3 }); expect(attempts).toBe(0);
  } finally {
    await page.close(); await request.dispose(); const closing = server.close(); server.server.closeAllConnections(); await closing;
    await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('a delayed old overview response cannot revive current after a user-prompt write', async ({ page }) => {
  const board = { tasks: [], resources: [], agents: [], usages: [], entries: [], cursor: 0 };
  const pool = { id: 'synthetic', workspacePath: '/synthetic', taskIds: [], size: 4, minSize: 2, maxSize: 8, version: 3, enabled: true, state: 'active', error: '' };
  await page.route('**/api/board', route => route.fulfill({ json: board }));
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'events', pool, workers: [] } }));
  await page.route('**/api/pool/configure', route => route.fulfill({ json: { ...pool, size: 5, version: 4 } }));
  const prompt = (text: string, version: number) => ({ boardId: 'fixture', text, version, source: 'human-input', updatedAt: null });
  let user = prompt('U', 0);
  await page.route('**/api/preferences', route => route.fulfill({ json: prompt('S', 1) }));
  await page.route('**/api/user-prompt', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: user });
    const input = route.request().postDataJSON(); user = { ...prompt(input.text, 1), source: input.source };
    return route.fulfill({ json: user });
  });
  const overview = (status: 'current' | 'stale') => ({ status, reason: status === 'current' ? null : 'USER_PROMPT_CHANGED',
    record: { boardId: 'fixture', version: 1, authorId: 'a', updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      preferencesVersion: 1, userPromptVersion: 0, factsRevision: 'r', factSnapshot: [], parts: [{ kind: 'text', text: 'Synthetic overview' }] },
    facts: { revision: 'r', observedAt: new Date().toISOString(), available: true, items: [] } });
  let calls = 0; let releaseSecond: (() => void) | undefined;
  await page.route('**/api/overview', async route => {
    calls++;
    if (calls === 2) { await new Promise<void>(resolve => { releaseSecond = () => { void route.fulfill({ json: overview('current') }); resolve(); }; }); return; }
    return route.fulfill({ json: calls >= 3 ? overview('stale') : overview('current') });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '增加成员', exact: true }).click();
  for (let i = 0; i < 100 && !releaseSecond; i++) await page.waitForTimeout(10);
  expect(releaseSecond).toBeTruthy();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('用户提示词内容', { exact: true }).fill('changed');
  await page.getByRole('button', { name: '保存用户提示词', exact: true }).click();
  await expect(page.getByText('用户提示词已保存。', { exact: true })).toBeVisible();
  releaseSecond!(); await page.waitForTimeout(50);
  await expect(page.getByRole('region', { name: '协作概览', exact: true })).toHaveAttribute('data-overview-state', 'stale');
});
