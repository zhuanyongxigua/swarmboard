// Verify resource definitions use the user prompt while legacy data remains historical,
// through real HTTP/SQLite and a simulated MCP Apps host without model execution.
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/app.js';

for (const lang of ['zh-CN', 'en']) for (const embedded of [false, true]) {
  test(`resources use only the user prompt in ${lang} ${embedded ? 'MCP host' : 'HTTP'}`, async ({ page }) => {
    const english = lang === 'en', directory = mkdtempSync(join(tmpdir(), 'resource-prompt-ui-'));
    const server = await startServer({ port: 0, dbPath: join(directory, 'board.sqlite') });
    const client = new Client({ name: 'resource-prompt-host', version: '1' });
    const calls: string[] = [];
    const resource = server.store.createResource({ name: 'Historical host', accessNotes: 'Historical note' });
    const agent = server.store.registerAgent({ name: 'Fixture author' });
    server.store.publishEntry({ agentId: agent.id, kind: 'FACT', summary: 'Historical resource reference', resourceId: resource.id });
    server.store.writeUserPrompt({ expectedVersion: 0, source: 'human-input', text: 'Resource Alpha: coordinate access.\nResource Beta: isolated use only.' });
    const originalResources = server.store.board().resources;
    try {
      if (embedded) {
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', server.url)));
        await page.exposeFunction('resourceHostTool', (params: { name: string; arguments?: Record<string, unknown> }) => { calls.push(params.name); return client.callTool(params); });
        await page.route('**/api/**', route => route.abort());
        await page.route('**/resource-host', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><script>
window.addEventListener('message',async e=>{const m=e.data;if(m?.jsonrpc!=='2.0'||m.id===undefined)return;let result;if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Fixture host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',displayMode:'inline'}};else if(m.method==='tools/call')result=await window.resourceHostTool(m.params);else return;e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
</script><iframe title="Board" src="/?lang=${lang}" style="width:100%;height:calc(100vh - 24px);border:0"></iframe></body></html>` }));
      }
      await page.goto(`${server.url}/${embedded ? 'resource-host' : `?lang=${lang}`}`);
      const surface = embedded ? page.frameLocator('iframe') : page;
      const open = () => surface.getByRole('button', { name: english ? 'Settings' : '设置', exact: true }).click();
      await open();
      await expect(surface.locator('.legacy-resources, .resource-grid, .resource-detail')).toHaveCount(0);
      await expect(surface.getByText(english ? 'Original resource records' : '原资源记录', { exact: true })).toHaveCount(0);
      const text = surface.getByLabel(english ? 'User prompt text' : '用户提示词内容', { exact: true });
      await expect(text).toHaveValue('Resource Alpha: coordinate access.\nResource Beta: isolated use only.');
      await text.fill('Resource Gamma: updated by the human.');
      await surface.getByRole('button', { name: english ? 'Save user prompt' : '保存用户提示词', exact: true }).click();
      await expect(text).toHaveValue('Resource Gamma: updated by the human.');
      await expect.poll(() => server.store.readUserPrompt().version).toBe(2);
      await surface.getByRole('button', { name: english ? 'Clear user prompt' : '清空用户提示词', exact: true }).click();
      await expect(text).toHaveValue('');
      await page.reload(); await open();
      await expect(surface.getByLabel(english ? 'User prompt text' : '用户提示词内容', { exact: true })).toHaveValue('');
      expect(server.store.readUserPrompt()).toMatchObject({ text: '', version: 3 });
      expect(server.store.readPreferences().version).toBe(0);
      expect(server.store.board().resources).toEqual(originalResources);
      await surface.getByRole('button', { name: english ? 'Close settings' : '关闭设置', exact: true }).click();
      await surface.getByRole('tab', { name: english ? 'Shared board' : '共享面板', exact: true }).click();
      const entry = surface.getByRole('article').filter({ hasText: 'Historical resource reference' });
      await expect(entry).toContainText('Historical host');
      await expect(entry.getByRole('button', { name: /Historical host/ })).toHaveCount(0);
      expect(calls.filter(name => /^resource_/.test(name))).toEqual([]);
    } finally { await page.goto('about:blank'); await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
