// Exercise the public native-draft contract in a simulated host; this cannot prove real Desktop placement or controls.
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Message = {
  role: string;
  content: { type: string; text?: string }[];
  _meta?: { 'openai/message'?: { target?: string; send?: boolean } };
};
type NativeHostWindow = Window & { nativeDraftMessages: Message[]; submittedMessages: Message[] };
type HostMode = 'supported' | 'unsupported' | 'mobile' | 'denied' | 'rpc-error';
const originalDraft = 'Keep my existing native draft.';

async function simulatedHost(page: Page, mode: HostMode = 'supported') {
  const client = new Client({ name: 'native-draft-contract-host', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4318/mcp')));
  // This suite tests task-context handoff; default automatic startup has its own fixture suite.
  async function seedTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as { version: number; state: string; recoveryRequired: boolean; requestId: string; setupMode: string; config?: { version: number; requestId: string } };
  }
  let config = await seedTool('automation_read');
  if (config.state === 'pending' || config.recoveryRequired) {
    const prepared = await seedTool('automation_prepare', { action: 'reconcile', expectedVersion: config.version });
    config = await seedTool('automation_reconcile', { expectedVersion: prepared.config!.version, requestId: prepared.config!.requestId, outcome: 'absent' });
  }
  if (config.state !== 'active') {
    const prepared = await seedTool('automation_prepare', { action: 'enable', expectedVersion: config.version });
    await seedTool('automation_confirm', { expectedVersion: prepared.config!.version, requestId: prepared.config!.requestId, automationId: 'discussion-fixture-native', status: 'ACTIVE', model: 'fixture-model', reasoningEffort: 'high', projectId: null });
  }
  const calls: string[] = [];
  let forbiddenApiCalls = 0;
  await page.exposeFunction('hostCallTool', async (params: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(params.name);
    return client.callTool(params);
  });
  await page.route('**/api/**', async route => { forbiddenApiCalls++; await route.abort(); });
  await page.route('**/native-host', async route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
<html><body><label>Simulated native composer<textarea id="native-composer">${originalDraft}</textarea></label><script>
window.nativeDraftMessages=[];window.submittedMessages=[];
window.addEventListener('message',async(event)=>{
 const m=event.data;if(m?.jsonrpc!=='2.0'||m.id===undefined)return;
 let result;
 if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Simulated native host',version:'1.0.0'},hostCapabilities:{serverTools:{},${mode === 'unsupported' ? '' : 'experimental:{"openai/message":{}},message:{text:{}}'}},hostContext:{theme:'light',displayMode:'fullscreen',platform:${JSON.stringify(mode === 'mobile' ? 'mobile' : 'desktop')}}};
 else if(m.method==='tools/call')result=await window.hostCallTool(m.params);
 else if(m.method==='ui/message'){
  // Capture the actual postMessage envelope before any base-schema parsing can strip extension metadata.
  window.nativeDraftMessages.push(m.params);
  if(${JSON.stringify(mode)}==='rpc-error'){event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Native draft request denied'}},'*');return;}
  if(${JSON.stringify(mode)}==='denied')result={isError:true};
  else if(m.params._meta?.['openai/message']?.send===false){
   const composer=document.getElementById('native-composer');composer.value+='\\n'+m.params.content.filter(item=>item.type==='text').map(item=>item.text).join('\\n');result={};
  }else{window.submittedMessages.push(m.params);result={};}
 }else{event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported fixture method'}},'*');return;}
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
});
</script><iframe sandbox="allow-scripts allow-same-origin allow-forms" title="Swarmboard native draft fixture" src="/" style="width:100%;height:1000px;border:0"></iframe></body></html>` }));
  await page.goto('/native-host');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText('已连接', { exact: true })).toBeVisible();
  return {
    frame, calls, close: () => client.close(),
    forbiddenApiCalls: () => forbiddenApiCalls,
    messages: () => page.evaluate(() => (window as unknown as NativeHostWindow).nativeDraftMessages),
    submitted: () => page.evaluate(() => (window as unknown as NativeHostWindow).submittedMessages),
  };
}

test('discussion appends a native draft only after a click and leaves persisted board data unchanged', async ({ page, request }) => {
  const created = await request.post('/api/tasks', { data: { title: 'Native discussion target', description: 'Clarify acceptance before implementation', acceptanceCriteria: 'Human confirms the final plan' } });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  const before = await (await request.get('/api/board')).json();
  const host = await simulatedHost(page);
  try {
    await expect(host.frame.getByRole('tab')).toHaveText(['任务管理', '资源池', '共享面板']);
    await host.frame.getByRole('button', { name: '刷新面板', exact: true }).click();
    await host.frame.getByRole('tab', { name: '资源池', exact: true }).click();
    await host.frame.getByRole('tab', { name: '共享面板', exact: true }).click();
    await expect(host.frame.getByRole('textbox')).toHaveCount(0);
    await host.frame.getByRole('tab', { name: '任务管理', exact: true }).click();
    expect(await host.messages()).toEqual([]);
    await expect(page.getByLabel('Simulated native composer')).toHaveValue(originalDraft);

    await expect(host.frame.getByRole('button', { name: '讨论方案', exact: true })).toHaveCount(0);
    await expect(host.frame.locator('.native-conversation-note')).toHaveCount(0);

    await host.frame.getByRole('button', { name: '查看任务 Native discussion target', exact: true }).click();
    await host.frame.getByLabel('任务说明').fill('Unsaved changes must stay out of the native draft');
    await host.frame.getByRole('button', { name: '讨论此任务', exact: true }).click();
    await expect.poll(async () => (await host.messages()).length).toBe(1);
    await expect(page.getByLabel('Simulated native composer')).toHaveValue(new RegExp(`^${originalDraft}\n`));
    const selected = (await host.messages())[0];
    expect(selected).toMatchObject({ role: 'user', _meta: { 'openai/message': { target: 'active', send: false } } });
    const text = selected.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    expect(text).toContain(task.id);
    expect(text).toContain(task.title);
    expect(text).toContain(task.description);
    expect(text).toContain(task.acceptanceCriteria);
    expect(text).not.toContain('Unsaved changes must stay out of the native draft');
    expect(await host.submitted()).toEqual([]);
    expect(host.calls.every(name => name === 'board_read' || name === 'context_read' || name === 'automation_read' || name === 'automation_ensure' || name === 'runtime_read')).toBe(true);
    expect(host.forbiddenApiCalls()).toBe(0);
    expect(await (await request.get('/api/board')).json()).toEqual(before);
  } finally { await host.close(); }
});

test('a host without the native draft extension keeps the board usable without offering immediate send', async ({ page, request }) => {
  await request.post('/api/tasks', { data: { title: 'Unsupported task discussion' } });
  const before = await (await request.get('/api/board')).json();
  const host = await simulatedHost(page, 'unsupported');
  try {
    await expect(host.frame.getByRole('button', { name: '讨论方案', exact: true })).toHaveCount(0);
    await host.frame.getByRole('button', { name: '查看任务 Unsupported task discussion', exact: true }).click();
    await expect(host.frame.getByRole('button', { name: '讨论此任务', exact: true })).toBeDisabled();
    await expect(host.frame.getByText('当前宿主不支持原生对话草稿追加，请在支持此功能的 ChatGPT 桌面端打开。', { exact: false })).toBeVisible();
    await host.frame.getByRole('button', { name: '关闭编辑窗口', exact: true }).click();
    await host.frame.getByRole('tab', { name: '资源池', exact: true }).click();
    await expect(host.frame.getByRole('button', { name: '添加资源', exact: true })).toBeEnabled();
    await host.frame.getByRole('tab', { name: '共享面板', exact: true }).click();
    await expect(host.frame.getByRole('textbox')).toHaveCount(0);
    expect(await host.messages()).toEqual([]);
    expect(await host.submitted()).toEqual([]);
    await expect(page.getByLabel('Simulated native composer')).toHaveValue(originalDraft);
    expect(await (await request.get('/api/board')).json()).toEqual(before);
  } finally { await host.close(); }
});

test('mobile host cannot append a draft even when it advertises native messaging capabilities', async ({ page, request }) => {
  await request.post('/api/tasks', { data: { title: 'Mobile task discussion' } });
  const before = await (await request.get('/api/board')).json();
  const host = await simulatedHost(page, 'mobile');
  try {
    await host.frame.getByRole('button', { name: '查看任务 Mobile task discussion', exact: true }).click();
    await expect(host.frame.getByRole('button', { name: '讨论此任务', exact: true })).toBeDisabled();
    await expect(host.frame.getByText('移动端暂不支持追加原生对话草稿，请在 ChatGPT 桌面端打开。', { exact: false })).toBeVisible();
    await host.frame.getByRole('button', { name: '关闭编辑窗口', exact: true }).click();
    await host.frame.getByRole('button', { name: '刷新面板', exact: true }).click();
    await host.frame.getByRole('tab', { name: '资源池', exact: true }).click();
    expect(await host.messages()).toEqual([]);
    expect(await host.submitted()).toEqual([]);
    await expect(page.getByLabel('Simulated native composer')).toHaveValue(originalDraft);
    expect(host.calls.every(name => name === 'board_read' || name === 'context_read' || name === 'automation_read' || name === 'automation_ensure' || name === 'runtime_read')).toBe(true);
    expect(host.forbiddenApiCalls()).toBe(0);
    expect(await (await request.get('/api/board')).json()).toEqual(before);
  } finally { await host.close(); }
});

for (const mode of ['denied', 'rpc-error'] as const) {
  test(`native draft ${mode} reports failure without immediate-send fallback or board mutation`, async ({ page, request }) => {
    await request.post('/api/tasks', { data: { title: `Denied task discussion ${mode}` } });
    const before = await (await request.get('/api/board')).json();
    const host = await simulatedHost(page, mode);
    try {
      await host.frame.getByRole('button', { name: `查看任务 Denied task discussion ${mode}`, exact: true }).click();
      await host.frame.getByRole('button', { name: '讨论此任务', exact: true }).click();
      const alert = host.frame.getByRole('alert');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(mode === 'denied' ? '宿主未接受草稿追加请求' : '无法追加到原生对话草稿');
      expect(await host.messages()).toHaveLength(1);
      expect((await host.messages())[0]).toMatchObject({ _meta: { 'openai/message': { target: 'active', send: false } } });
      expect(await host.submitted()).toEqual([]);
      await expect(page.getByLabel('Simulated native composer')).toHaveValue(originalDraft);
      expect(host.calls.every(name => name === 'board_read' || name === 'context_read' || name === 'automation_read' || name === 'automation_ensure' || name === 'runtime_read')).toBe(true);
      expect(host.forbiddenApiCalls()).toBe(0);
      expect(await (await request.get('/api/board')).json()).toEqual(before);
    } finally { await host.close(); }
  });
}

test('standalone browser keeps a compact header and shows native availability only in task details', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveText(['任务管理', '资源池', '共享面板']);
  await expect(page.getByRole('button', { name: '讨论方案', exact: true })).toHaveCount(0);
  await expect(page.locator('.native-conversation-note')).toHaveCount(0);
  await request.post('/api/tasks', { data: { title: 'Standalone task discussion' } });
  await page.reload();
  await page.getByRole('button', { name: '查看任务 Standalone task discussion', exact: true }).click();
  await expect(page.getByRole('button', { name: '讨论此任务', exact: true })).toBeDisabled();
  await expect(page.getByText('HTTP 预览不提供原生对话，请在 ChatGPT 桌面端打开插件。', { exact: false })).toBeVisible();
});
