import { seedLegacyResource } from './legacy-fixtures.js';
import { openResources } from './settings-helpers.js';
// Connect the actual editor to HTTP/SQLite, including a new server process on
// the same synthetic database; no route mocks, model sessions or live board.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function start(dbPath: string) {
  const source = `// Keep this isolated HTTP fixture's process lifecycle independent of model runtimes.
import { startServer } from './src/app.ts';
const server = await startServer({ port: 0, dbPath: process.argv[1] });
console.log(JSON.stringify({ url: server.url }));
process.once('SIGTERM', () => { void server.close().then(() => process.exit(0)); });`;
  const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]! ]));
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, dbPath], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout!.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('\n')) { try { resolve(JSON.parse(stdout.split('\n')[0]!).url); } catch (error) { reject(error); } }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Fixture exited before ready: ${code}; ${stderr}`)));
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try { return { child, url: await ready }; } finally { clearTimeout(timer); }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const fallback = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { expect((await ended)[0]).toBe(0); } finally { clearTimeout(fallback); }
}

test('real preferences editor persists across server processes, preserves conflicts and clears with a newer empty version', async ({ page, request }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'preferences-real-'));
  let running = await start(join(directory, 'board.sqlite'));
  try {
    const resource = seedLegacyResource({ name: 'Synthetic retained resource', kind: 'legacy', accessNotes: 'Synthetic coordination note' }, join(directory, 'board.sqlite'));
    await page.goto(running.url);
    await openResources(page);
    await expect(page.getByRole('button', { name: '查看资源 Synthetic retained resource', exact: true })).toBeVisible();
    await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('');
    await page.getByLabel('系统提示词内容', { exact: true }).fill('Synthetic saved expectation');
    await page.getByLabel('系统提示词 · 内容来源', { exact: true }).selectOption('main-chat-relay');
    await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
    await expect(page.getByLabel('当前保存的系统提示词')).toContainText('v1');
    const saved = await (await request.get(`${running.url}/api/preferences`)).json();
    expect(saved).toMatchObject({ text: 'Synthetic saved expectation', version: 1, source: 'main-chat-relay' });

    await page.goto('about:blank');
    const firstPid = running.child.pid;
    await stop(running.child);
    running = await start(join(directory, 'board.sqlite'));
    expect(running.child.pid).not.toBe(firstPid);
    await page.goto(running.url);
    await openResources(page);
    await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Synthetic saved expectation');
    expect(await (await request.get(`${running.url}/api/preferences`)).json()).toEqual(saved);
    const board = await (await request.get(`${running.url}/api/board`)).json();
    expect(board.resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({ id: resource.id, kind: 'legacy', accessNotes: 'Synthetic coordination note' });

    await page.getByLabel('系统提示词内容', { exact: true }).fill('Synthetic retained draft');
    expect((await request.patch(`${running.url}/api/preferences`, { data: { text: 'Synthetic concurrent value', source: 'human-input', expectedVersion: 1 } })).ok()).toBe(true);
    await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('草稿已保留');
    await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('Synthetic retained draft');
    await expect(page.getByLabel('当前保存的系统提示词')).toContainText('Synthetic concurrent value');
    await expect(page.getByRole('button', { name: '保存系统提示词', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '按当前版本继续编辑', exact: true }).click();
    await page.getByRole('button', { name: '保存系统提示词', exact: true }).click();
    await expect(page.getByLabel('当前保存的系统提示词')).toContainText('v3');
    await page.getByRole('button', { name: '清空系统提示词', exact: true }).click();
    await expect(page.getByLabel('系统提示词内容', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('当前保存的系统提示词')).toContainText('v4');
    const cleared = await (await request.get(`${running.url}/api/preferences`)).json();
    expect(cleared).toMatchObject({ text: '', version: 4 });

    await page.goto('about:blank'); await stop(running.child);
    running = await start(join(directory, 'board.sqlite'));
    await page.goto(`${running.url}/?lang=en`);
    await openResources(page);
    await expect(page.getByLabel('System prompt text', { exact: true })).toHaveValue('');
    expect(await (await request.get(`${running.url}/api/preferences`)).json()).toEqual(cleared);
    await expect(page.getByRole('button', { name: 'Clear system prompt', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('preferences-real-empty.png'), fullPage: true });
  } finally { await page.goto('about:blank'); await stop(running.child); rmSync(directory, { recursive: true, force: true }); }
});
