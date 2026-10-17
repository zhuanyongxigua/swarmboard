// Verify native setup dispatch and persisted status with an isolated real service, never real host schedules.
import { test, expect, type Page } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AutomationConfig } from '../../src/automation.js';

type Mode = 'supported' | 'unsupported' | 'mobile' | 'denied' | 'rpc-error';
type NativeMessage = { role: string; content: { type: string; text?: string }[]; _meta?: { 'openai/message'?: { target?: string; send?: boolean } } };
const originalDraft = 'My existing discussion draft.';
async function simulatedHost(page: Page, mode: Mode = 'supported', english = false) {
  const client = new Client({ name: 'auto-claim-simulated-host', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4318/mcp')));
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  await page.exposeFunction('automationHostCall', async (params: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(params); return client.callTool(params);
  });
  await page.route('**/automation-host', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
<label>Native draft<textarea id="draft">${originalDraft}</textarea></label><script>
window.setupMessages=[];
window.addEventListener('message',async(event)=>{
 const m=event.data;if(m?.jsonrpc!=='2.0'||m.id===undefined)return;
 let result;
 if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Test host',version:'1'},hostCapabilities:{serverTools:{},${mode === 'unsupported' ? '' : 'experimental:{"openai/message":{}},message:{text:{}}'}},hostContext:{theme:'light',displayMode:'fullscreen',platform:${JSON.stringify(mode === 'mobile' ? 'mobile' : 'desktop')}}};
 else if(m.method==='tools/call')result=await window.automationHostCall(m.params);
 else if(m.method==='ui/message'){
  window.setupMessages.push(m.params);
  if(${JSON.stringify(mode)}==='rpc-error'){event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Simulated native setup transport failure'}},'*');return;}
  result=${mode === 'denied' ? '{isError:true}' : '{}'};
 }else{event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown simulated method'}},'*');return;}
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
});</script><iframe title="Swarmboard" src="/${english ? '?lang=en' : ''}" style="width:100%;height:calc(100vh - 90px);border:0"></iframe></body></html>` }));
  await page.goto('/automation-host');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText(english ? 'Connected' : '已连接', { exact: true })).toBeVisible();
  async function tool<T>(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0].text)) as T;
  }
  return { frame, calls, tool, rawTool: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }), close: () => client.close(), messages: () => page.evaluate(() => (window as unknown as { setupMessages: NativeMessage[] }).setupMessages) };
}

test('explicit auto-claim setup uses a new native conversation and waits for persisted host confirmations', async ({ page }) => {
  const host = await simulatedHost(page);
  try {
    const initial = await host.tool<AutomationConfig>('automation_read');
    expect(initial).toMatchObject({ state: 'off', desiredEnabled: false, actualStatus: null, intervalMinutes: 10 });
    await host.frame.getByRole('button', { name: '自动认领', exact: true }).click();
    const dialog = host.frame.getByRole('dialog', { name: '自动认领', exact: true });
    await expect(dialog.getByText('未启用', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('检查间隔')).toHaveValue('10');
    expect(await host.messages()).toEqual([]);
    expect(host.calls.every(call => ['board_read', 'automation_read'].includes(call.name))).toBe(true);
    await expect(page.getByLabel('Native draft')).toHaveValue(originalDraft);
    await dialog.getByLabel('工作目录').fill('relative/path');
    await expect(dialog.getByRole('button', { name: '在新会话中启用' })).toBeDisabled();
    await dialog.getByLabel('工作目录').fill(realpathSync(tmpdir()));
    await dialog.getByLabel('检查间隔').selectOption('5');
    await dialog.getByRole('button', { name: '在新会话中启用' }).click();
    await expect(dialog.getByText('等待宿主确认启用', { exact: true })).toBeVisible();
    await expect.poll(async () => (await host.messages()).length).toBe(1);
    const wire = (await host.messages())[0];
    expect(wire).toMatchObject({ role: 'user', _meta: { 'openai/message': { target: 'new', send: true } } });
    expect(wire.content[0].text).toContain('automation_update');
    expect(wire.content[0].text).toContain(realpathSync(tmpdir()));
    await expect(page.getByLabel('Native draft')).toHaveValue(originalDraft);
    let config = await host.tool<AutomationConfig>('automation_read');
    expect(config).toMatchObject({ state: 'pending', actualStatus: null, desiredEnabled: true, intervalMinutes: 5 });
    await expect(dialog.getByRole('button', { name: '核对宿主状态' })).toBeEnabled();
    const stale = config;
    await dialog.getByRole('button', { name: '核对宿主状态' }).click();
    await expect(dialog.getByText('等待核对宿主状态', { exact: true })).toBeVisible();
    config = await host.tool<AutomationConfig>('automation_read');
    expect(config).toMatchObject({ state: 'pending', setupMode: 'reconcile', recoveryRequired: true, actualStatus: null });
    expect(config.version).toBeGreaterThan(stale.version); expect(config.requestId).not.toBe(stale.requestId);
    expect((await host.messages())[1].content[0].text).toContain('READ-ONLY native reconciliation');
    expect((await host.rawTool('automation_confirm', { expectedVersion: stale.version, requestId: stale.requestId, automationId: 'stale-schedule', status: 'ACTIVE', model: 'simulated-model', reasoningEffort: 'low', projectId: 'simulated-project' })).isError).toBe(true);
    await host.tool('automation_reconcile', { expectedVersion: config.version, requestId: config.requestId, outcome: 'absent' });
    await dialog.getByRole('button', { name: '刷新状态' }).click();
    await expect(dialog.getByText('未启用', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '在新会话中启用' }).click();
    await expect(dialog.getByText('等待宿主确认启用', { exact: true })).toBeVisible();
    config = await host.tool<AutomationConfig>('automation_read');
    await host.tool('automation_confirm', { expectedVersion: config.version, requestId: config.requestId, automationId: 'simulated-schedule', status: 'ACTIVE', model: 'simulated-model', reasoningEffort: 'low', projectId: 'simulated-project' });
    await dialog.getByRole('button', { name: '刷新状态' }).click();
    await expect(dialog.getByText('已启用', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '在新会话中暂停' }).click();
    await expect(dialog.getByText('等待宿主确认暂停', { exact: true })).toBeVisible();
    config = await host.tool<AutomationConfig>('automation_read');
    expect(config).toMatchObject({ state: 'pending', desiredEnabled: false, actualStatus: 'ACTIVE' });
    await expect(dialog.getByText('配置会话最后报告：运行中', { exact: false })).toBeVisible();
    expect(await host.messages()).toHaveLength(4);
    await host.tool('automation_confirm', { expectedVersion: config.version, requestId: config.requestId, automationId: 'simulated-schedule', status: 'PAUSED', model: 'simulated-model', reasoningEffort: 'low', projectId: 'simulated-project' });
    await dialog.getByRole('button', { name: '刷新状态' }).click();
    await expect(dialog.getByText('未启用', { exact: true })).toBeVisible();
    await expect(dialog.getByText('配置会话最后报告：已暂停', { exact: false })).toBeVisible();
    expect(host.calls.filter(call => call.name === 'automation_prepare').map(call => call.arguments?.action)).toEqual(['enable', 'reconcile', 'enable', 'pause']);
    expect(host.calls.some(call => ['task_claim', 'task_update', 'automation_confirm'].includes(call.name))).toBe(false);
  } finally { await host.close(); }
});

for (const mode of ['denied', 'rpc-error'] as const) {
  test(`auto-claim ${mode} records setup failure without falsely confirming native status`, async ({ page }) => {
    const host = await simulatedHost(page, mode);
    try {
      const before = await host.tool<AutomationConfig>('automation_read');
      await host.frame.getByRole('button', { name: '自动认领', exact: true }).click();
      const dialog = host.frame.getByRole('dialog');
      await dialog.getByLabel('工作目录').fill(realpathSync(tmpdir()));
      await dialog.getByRole('button', { name: '在新会话中启用' }).click();
      await expect(dialog.getByText('配置失败', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('alert')).toContainText(mode === 'denied' ? '宿主未接受自动认领配置请求' : 'Simulated native setup transport failure');
      const after = await host.tool<AutomationConfig>('automation_read');
      expect(after.state).toBe('error'); expect(after.actualStatus).toBe(before.actualStatus);
      expect(after.recoveryRequired).toBe(true);
      await expect(dialog.getByRole('button', { name: '核对宿主状态' })).toBeEnabled();
      expect(host.calls.filter(call => call.name === 'automation_setup_failed')).toHaveLength(1);
      expect(host.calls.some(call => call.name === 'automation_confirm')).toBe(false);
      expect(await host.messages()).toHaveLength(1);
      await expect(page.getByLabel('Native draft')).toHaveValue(originalDraft);
      const recovery = await host.tool<{ config: AutomationConfig }>('automation_prepare', { action: 'reconcile', expectedVersion: after.version });
      await host.tool('automation_reconcile', { expectedVersion: recovery.config.version, requestId: recovery.config.requestId, outcome: 'absent' });
    } finally { await host.close(); }
  });
}

for (const mode of ['unsupported', 'mobile'] as const) {
  test(`${mode} host disables auto-claim actions and keeps the board usable`, async ({ page }) => {
    const host = await simulatedHost(page, mode);
    try {
      const before = await host.tool<AutomationConfig>('automation_read');
      await host.frame.getByRole('button', { name: '自动认领', exact: true }).click();
      const dialog = host.frame.getByRole('dialog');
      await expect(dialog.getByText('自动认领需要支持原生消息的桌面宿主。')).toBeVisible();
      await expect(dialog.getByLabel('工作目录')).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '在新会话中启用' })).toBeDisabled();
      await dialog.getByRole('button', { name: '关闭自动认领设置' }).click();
      await host.frame.getByRole('tab', { name: '资源池', exact: true }).click();
      await expect(host.frame.getByRole('button', { name: '添加资源', exact: true })).toBeEnabled();
      expect(await host.messages()).toEqual([]);
      expect(host.calls.every(call => ['board_read', 'automation_read'].includes(call.name))).toBe(true);
      expect(await host.tool<AutomationConfig>('automation_read')).toEqual(before);
    } finally { await host.close(); }
  });
}

test('English auto-claim settings are localized and standalone preview cannot configure a host schedule', async ({ page }) => {
  const host = await simulatedHost(page, 'supported', true);
  try {
    await host.frame.getByRole('button', { name: 'Auto-claim', exact: true }).click();
    const dialog = host.frame.getByRole('dialog', { name: 'Auto-claim' });
    await expect(dialog.getByLabel('Workspace path')).toBeVisible();
    await expect(dialog.getByLabel('Check interval')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Enable in new conversation|Check native status/ })).toBeVisible();
    expect(await host.messages()).toEqual([]);
  } finally { await host.close(); }
  await page.goto('/');
  await page.getByRole('button', { name: '自动认领', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '在新会话中启用' })).toBeDisabled();
  await expect(page.getByText('自动认领需要支持原生消息的桌面宿主。')).toBeVisible();
});
