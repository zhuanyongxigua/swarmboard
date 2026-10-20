import { openSettings, refreshBoard, closeSettings } from './settings-helpers.js';
// Verify built-in auto-claim initialization with isolated HTTP MCP databases, never real host schedules.
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/app.js';
import type { AutomationConfig } from '../../src/automation.js';

type Mode = 'supported' | 'unsupported' | 'mobile' | 'denied' | 'rpc-error';
type NativeMessage = { role: string; content: { type: string; text?: string }[]; _meta?: { 'openai/message'?: { target?: string; send?: boolean } } };
const originalDraft = 'My existing discussion draft.';
async function simulatedHost(page: Page, mode: Mode = 'supported', english = false) {
  await page.clock.install();
  const directory = mkdtempSync(join(tmpdir(), 'swarmboard-auto-ui-'));
  const server = await startServer({ port: 0, dbPath: join(directory, 'board.sqlite') });
  const beforeBoard = server.store.board();
  const client = new Client({ name: 'auto-claim-simulated-host', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const messages: NativeMessage[] = [];
  await page.exposeFunction('recordAutomaticMessage', (message: NativeMessage) => { messages.push(message); });
  await page.exposeFunction('automationHostCall', async (params: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(params); return client.callTool(params);
  });
  await page.route('**/automation-host', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
<label>Native draft<textarea id="draft">${originalDraft}</textarea></label><script>
window.addEventListener('message',async(event)=>{
 const m=event.data;if(m?.jsonrpc!=='2.0'||m.id===undefined)return;
 let result;
 if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Test host',version:'1'},hostCapabilities:{serverTools:{},${mode === 'unsupported' ? '' : 'experimental:{"openai/message":{}},message:{text:{}}'}},hostContext:{theme:'light',displayMode:'fullscreen',platform:${JSON.stringify(mode === 'mobile' ? 'mobile' : 'desktop')}}};
 else if(m.method==='tools/call')result=await window.automationHostCall(m.params);
 else if(m.method==='ui/message'){
  await window.recordAutomaticMessage(m.params);
  if(${JSON.stringify(mode)}==='rpc-error'){event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Simulated native setup transport failure'}},'*');return;}
  result=${mode === 'denied' ? '{isError:true}' : '{}'};
 }else{event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown simulated method'}},'*');return;}
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
});</script><iframe title="Swarmboard" src="/${english ? '?lang=en' : ''}" style="width:100%;height:calc(100vh - 90px);border:0"></iframe></body></html>` }));
  await page.goto('/automation-host');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: english ? 'Settings' : '设置', exact: true })).toBeVisible();
  async function tool<T>(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0].text)) as T;
  }
  return {
    frame, calls, messages, tool, beforeBoard, board: () => server.store.board(),
    rawTool: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    close: async () => { await page.goto('about:blank'); await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function assertCompactHeader(frame: ReturnType<Page['frameLocator']>, english = false) {
  await closeSettings(frame);
  await expect(frame.getByRole('tab')).toHaveText(english ? ['Tasks', 'Shared board'] : ['任务管理', '共享面板']);
  await expect(frame.getByRole('banner').getByRole('button')).toHaveCount(1);
  await expect(frame.getByRole('banner').getByRole('button', { name: english ? 'Settings' : '设置' })).toBeVisible();
  await expect(frame.getByRole('button', { name: /自动认领|Auto-claim|讨论方案/ })).toHaveCount(0);
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  await expect(frame.getByRole('switch')).toHaveCount(0);
}

test('opening a supported host initializes once in a new conversation without extra controls or premature activation', async ({ page }) => {
  const host = await simulatedHost(page);
  try {
    await assertCompactHeader(host.frame);
    await expect.poll(() => host.messages.length).toBe(1);
    await expect(host.frame.getByText('正在初始化自动认领，等待宿主确认。', { exact: true })).toBeVisible();
    expect(host.messages[0]).toMatchObject({ role: 'user', _meta: { 'openai/message': { target: 'new', send: true } } });
    expect(host.messages[0].content[0].text).toContain('automation_update');
    let config = await host.tool<AutomationConfig>('automation_read');
    expect(config).toMatchObject({ state: 'pending', desiredEnabled: true, actualStatus: null, workspacePath: '', projectId: null });
    await expect(page.getByLabel('Native draft')).toHaveValue(originalDraft);
    expect(host.calls.filter(call => call.name === 'automation_ensure').map(call => call.arguments)).toEqual([{ retry: false }]);
    expect(host.board()).toEqual(host.beforeBoard);

    const reads = host.calls.filter(call => call.name === 'board_read').length;
    await page.clock.fastForward(16000);
    await expect.poll(() => host.calls.filter(call => call.name === 'board_read').length).toBeGreaterThan(reads);
    expect(host.messages).toHaveLength(1);
    expect(host.calls.filter(call => call.name === 'automation_ensure')).toHaveLength(1);
    await page.reload();
    await expect.poll(() => host.calls.filter(call => call.name === 'automation_ensure').length).toBe(2);
    expect(host.messages).toHaveLength(1);
    expect((await host.tool<AutomationConfig>('automation_read')).requestId).toBe(config.requestId);

    const stale = config;
    await refreshBoard(host.frame);
    await expect.poll(() => host.messages.length).toBe(2);
    await expect(host.frame.getByText('正在核对自动认领状态。', { exact: true })).toBeVisible();
    config = await host.tool<AutomationConfig>('automation_read');
    expect(config).toMatchObject({ state: 'pending', setupMode: 'reconcile', recoveryRequired: true, actualStatus: null });
    expect(config.requestId).not.toBe(stale.requestId);
    expect(host.messages[1].content[0].text).toContain('READ-ONLY native reconciliation');
    expect((await host.rawTool('automation_confirm', { expectedVersion: stale.version, requestId: stale.requestId, automationId: 'stale-schedule', status: 'ACTIVE', model: 'simulated-model', reasoningEffort: 'low', projectId: null })).isError).toBe(true);
    await host.tool('automation_reconcile', { expectedVersion: config.version, requestId: config.requestId, outcome: 'absent' });
    const ensures = host.calls.filter(call => call.name === 'automation_ensure').length;
    await page.clock.fastForward(16000);
    expect(host.calls.filter(call => call.name === 'automation_ensure')).toHaveLength(ensures);
    expect(host.messages).toHaveLength(2);
    await refreshBoard(host.frame);
    await expect.poll(() => host.messages.length).toBe(3);
    config = await host.tool<AutomationConfig>('automation_read');
    await host.tool('automation_confirm', { expectedVersion: config.version, requestId: config.requestId, automationId: 'simulated-schedule', status: 'ACTIVE', model: 'simulated-model', reasoningEffort: 'low', projectId: null });
    await refreshBoard(host.frame);
    await expect(host.frame.locator('.automation-notice')).toHaveCount(0);
    expect(host.messages).toHaveLength(3);
    expect(host.board()).toEqual(host.beforeBoard);
    await assertCompactHeader(host.frame);
  } finally { await host.close(); }
});

for (const mode of ['denied', 'rpc-error'] as const) {
  test(`automatic initialization ${mode} records failure and never retries from polling or reload`, async ({ page }) => {
    const host = await simulatedHost(page, mode);
    try {
      await expect(host.frame.getByRole('alert')).toContainText(mode === 'denied' ? '宿主未接受自动认领配置请求' : 'Simulated native setup transport failure');
      const failed = await host.tool<AutomationConfig>('automation_read');
      expect(failed).toMatchObject({ state: 'error', actualStatus: null, recoveryRequired: true });
      expect(host.messages).toHaveLength(1);
      expect(host.calls.filter(call => call.name === 'automation_setup_failed')).toHaveLength(1);
        await page.clock.fastForward(31000);
      expect(host.messages).toHaveLength(1);
      await page.reload();
      await expect.poll(() => host.calls.filter(call => call.name === 'automation_ensure').length).toBe(2);
      expect(host.messages).toHaveLength(1);
      expect((await host.tool<AutomationConfig>('automation_read')).version).toBe(failed.version);
      await refreshBoard(host.frame);
      await expect.poll(() => host.messages.length).toBe(2);
      expect(host.messages[1].content[0].text).toContain('READ-ONLY native reconciliation');
      expect((await host.tool<AutomationConfig>('automation_read')).actualStatus).toBe(null);
      await expect(page.getByLabel('Native draft')).toHaveValue(originalDraft);
      expect(host.board()).toEqual(host.beforeBoard);
      await assertCompactHeader(host.frame);
    } finally { await host.close(); }
  });
}

for (const mode of ['unsupported', 'mobile'] as const) {
  test(`${mode} host keeps tasks usable without sending or initializing unsupported native automation`, async ({ page }) => {
    const host = await simulatedHost(page, mode);
    try {
      await expect(host.frame.getByText('当前宿主不支持自动认领，任务与资源仍可使用。')).toBeVisible();
      expect(host.calls.every(call => ['board_read', 'automation_read', 'runtime_read'].includes(call.name))).toBe(true);
      expect(host.messages).toEqual([]);
      expect(await host.tool<AutomationConfig>('automation_read')).toMatchObject({ state: 'off', desiredEnabled: true, actualStatus: null, version: 0 });
      await openSettings(host.frame);
      await expect(host.frame.getByLabel('用户提示词内容', { exact: true })).toBeEnabled();
      await assertCompactHeader(host.frame);
    } finally { await host.close(); }
  });
}

test('English initialization is localized while standalone preview stays clean and has no auto-claim controls', async ({ page }) => {
  const host = await simulatedHost(page, 'supported', true);
  try {
    await expect(host.frame.getByText('Initializing auto-claim; awaiting native confirmation.', { exact: true })).toBeVisible();
    await assertCompactHeader(host.frame, true);
    expect(host.messages).toHaveLength(1);
  } finally { await host.close(); }
  await page.goto('/');
  await expect(page.getByRole('banner').getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /自动认领|Auto-claim/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '协作概览', exact: true })).toHaveText('协作情况未知');
  await expect(page.getByRole('button', { name: '停止协作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '共享面板']);
});
