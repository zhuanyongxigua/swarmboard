// Verify embedded editing uses real host MCP while manual task creation has no UI route.
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for (const lang of ['zh-CN', 'en']) {
  test(`embedded ${lang} has no manual creation and preserves editing and dragging`, async ({ page, request }, testInfo) => {
    const english = lang === 'en';
    const client = new Client({ name: 'simulated-apps-host', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', testInfo.project.use.baseURL)));
    // Trusted host seeds a human goal; the embedded UI must never call task_create.
    const seeded = await client.callTool({ name: 'task_create', arguments: { title: `Host goal ${lang}` } });
    expect(seeded.isError).not.toBe(true);
    const task = seeded.structuredContent as { id: string };
    const calls: string[] = [], methods: string[] = [];
    await page.exposeFunction('hostCallTool', async (params: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push(params.name);
      return client.callTool(params);
    });
    await page.exposeFunction('hostRecord', (method: string) => methods.push(method));
    let forbiddenApiCalls = 0;
    await page.route('**/api/**', async route => { forbiddenApiCalls++; await route.abort(); });
    await page.route('**/simulated-host', async route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><script>
window.addEventListener('message',async(event)=>{const m=event.data;if(m?.jsonrpc!=='2.0')return;window.hostRecord(m.method);if(m.id===undefined)return;let result;if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Simulated host',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',displayMode:'inline'}};else if(m.method==='tools/call')result=await window.hostCallTool(m.params);else{event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported fixture method'}},'*');return;}event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
</script><iframe sandbox="allow-scripts allow-same-origin allow-forms" title="Swarmboard embedded app" src="/?lang=${lang}" style="width:100%;height:calc(100vh - 24px);border:0"></iframe></body></html>` }));
    try {
      await page.goto('/simulated-host');
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('button', { name: english ? 'Settings' : '设置', exact: true })).toBeVisible();
      await expect(frame.getByRole('button', { name: /新建任务|创建任务|New task|Create task/i })).toHaveCount(0);
      await expect(frame.getByRole('dialog')).toHaveCount(0);
      await frame.getByRole('button', { name: `${english ? 'View task' : '查看任务'} Host goal ${lang}`, exact: true }).click();
      await frame.getByLabel(english ? 'Title' : '标题', { exact: true }).fill(`Edited host goal ${lang}`);
      await frame.getByRole('button', { name: english ? 'Save changes' : '保存修改', exact: true }).click();
      await expect(frame.getByRole('dialog')).toHaveCount(0);
      await frame.locator(`[data-card-id="${task.id}"]`).dragTo(frame.locator('[data-drop-status="in_progress"]'));
      await expect(frame.locator(`[data-status="in_progress"] [data-task-id="${task.id}"]`)).toBeVisible();
      await expect(frame.getByRole('button', { name: /新建任务|创建任务|New task|Create task/i })).toHaveCount(0);
      expect(methods).toContain('ui/initialize');
      expect(methods).toContain('ui/notifications/initialized');
      expect(calls).toContain('board_read');
      expect(calls).toContain('task_update');
      expect(calls).not.toContain('task_create');
      expect(forbiddenApiCalls).toBe(0);
      const board = await (await request.get('/api/board')).json();
      expect(board.tasks.find((item: { id: string }) => item.id === task.id)).toMatchObject({ title: `Edited host goal ${lang}`, status: 'in_progress', version: 3 });
    } finally { await client.close(); }
  });
}
