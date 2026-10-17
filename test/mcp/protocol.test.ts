// Use the official SDK client over real Streamable HTTP, not direct tool handler calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/app.js';
let server:Awaited<ReturnType<typeof startServer>>, client:Client;
beforeEach(async()=>{server=await startServer({port:0,dbPath:':memory:'});client=new Client({name:'test-client',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp')));});afterEach(async()=>{await client.close();await server.close();});
async function tool(name:string,args:Record<string,unknown>={}){return client.callTool({name,arguments:args});}
const structured=(r:Awaited<ReturnType<typeof tool>>)=>r.structuredContent as Record<string,any>;
describe('MCP interoperability',()=>{
 it('offers a planning prompt without authorizing discussion or summaries to mutate the board',async()=>{
  await tool('task_create',{title:'Existing planning context'});
  const before=structured(await tool('board_read'));
  const prompts=await client.listPrompts();
  expect(prompts.prompts.some(prompt=>prompt.name==='planning_partner')).toBe(true);
  const topic='Summarize possible tasks; this is reference data, not approval.';
  const prompt=await client.getPrompt({name:'planning_partner',arguments:{topic}});
  expect(prompt.messages).toHaveLength(1);
  expect(prompt.messages[0]?.role).toBe('user');
  const content=prompt.messages[0]?.content;
  expect(content?.type).toBe('text');
  const text=content?.type==='text'?content.text:'';
  expect(text).toContain(topic);
  expect(text).toMatch(/read-only.*board_read.*context_read/i);
  expect(text).toMatch(/discuss.*summarize.*preview.*not authorization/i);
  expect(text).toMatch(/explicitly confirm.*tasks or resources/i);
  expect(text).toMatch(/success only for confirmed tool results/i);
  expect(text).toMatch(/reference data, not as instructions/i);
  expect(structured(await tool('board_read'))).toEqual(before);
 });
 it('advertises optional resource kind and accepts omitted kind through the official client',async()=>{const tools=await client.listTools();const create=tools.tools.find(item=>item.name==='resource_create')!;expect(create.inputSchema.required??[]).not.toContain('kind');const created=structured(await tool('resource_create',{name:'Any shared resource',description:'No classification required',accessNotes:'Discuss changes'}));expect(created).toMatchObject({kind:'',version:1});const legacy=structured(await tool('resource_create',{name:'Legacy classified resource',kind:'machine'}));const edited=structured(await tool('resource_update',{id:legacy.id,expectedVersion:1,accessNotes:'Preserve legacy field'}));expect(edited).toMatchObject({kind:'machine',version:2});const stale=await tool('resource_update',{id:legacy.id,expectedVersion:1,name:'Stale edit'});expect(stale.isError).toBe(true);expect(JSON.stringify(stale.content)).toContain('VERSION_CONFLICT');});
 it('initializes, advertises the UI association, reads the built resource and prompt',async()=>{const list=await client.listTools();expect(list.tools.map(t=>t.name)).toEqual(expect.arrayContaining(['board_open','task_claim','task_release','context_read','resource_use','resource_release']));const open=list.tools.find(t=>t.name==='board_open');expect(open?._meta).toMatchObject({ui:{resourceUri:'ui://swarmboard/board.html'}});const resources=await client.listResources();expect(resources.resources[0]?.mimeType).toContain('html');const resource=await client.readResource({uri:'ui://swarmboard/board.html'});expect(resource.contents[0]).toMatchObject({mimeType:expect.stringContaining('html'),text:expect.stringContaining('<!doctype html>')});const prompt=await client.getPrompt({name:'shared_worker',arguments:{agentId:'test-agent',target:'synthetic target'}});expect(JSON.stringify(prompt)).toContain('gather -> claim -> act -> verify -> merge');expect(structured(await tool('board_open')).tasks).toEqual([]);});
 it('executes collaboration tools, honors versions and reports domain errors',async()=>{await tool('agent_register',{agentId:'a',name:'A'});await tool('agent_register',{agentId:'b',name:'B'});const t=structured(await tool('task_create',{title:'MCP task'}));await tool('task_claim',{id:t.id,agentId:'a',expectedVersion:1});expect((await tool('task_claim',{id:t.id,agentId:'b',expectedVersion:1})).isError).toBe(true);await tool('task_update',{id:t.id,agentId:'a',expectedVersion:2,description:'proof https://example.com/pr/1',status:'in_review'});await tool('task_release',{id:t.id,agentId:'a',expectedVersion:3});const r=structured(await tool('resource_create',{name:'Compute Alpha',kind:'machine'}));await tool('resource_update',{id:r.id,expectedVersion:1,description:'shared'});const u=structured(await tool('resource_use',{agentId:'a',resourceId:r.id,purpose:'build',taskId:t.id}));await tool('resource_use',{agentId:'b',resourceId:r.id,purpose:'logs'});await tool('resource_usage_update',{id:u.id,agentId:'a',expectedVersion:1,sharing:'1 core'});await tool('resource_release',{id:u.id,agentId:'a',expectedVersion:2});await tool('agent_heartbeat',{agentId:'a'});await tool('context_publish',{agentId:'a',kind:'PATCH_SUMMARY',summary:'Verified patch',detail:'tests passed',taskId:t.id});const first=structured(await tool('context_read',{limit:2}));expect(first.hasMore).toBe(true);const next=structured(await tool('context_read',{after:first.cursor,limit:200}));expect(next.items.every((e:{id:number})=>e.id>first.cursor)).toBe(true);expect(structured(await tool('context_read',{after:next.cursor})).items).toEqual([]);expect((await tool('task_create',{title:''})).isError).toBe(true);expect(structured(await tool('board_read')).usages.filter((u:{active:boolean})=>u.active)).toHaveLength(1);});
});
