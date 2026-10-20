// This is a simulated MCP Apps host contract test, not a real ChatGPT installation test.
import {test,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('embedded app initializes and routes UI actions through host to real MCP service',async({page,request},testInfo)=>{
 const client=new Client({name:'simulated-apps-host',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',testInfo.project.use.baseURL)));const calls:string[]=[];const methods:string[]=[];
 await page.exposeFunction('hostCallTool',async(params:{name:string;arguments?:Record<string,unknown>})=>{calls.push(params.name);return client.callTool(params);});
 await page.exposeFunction('hostRecord',(method:string)=>methods.push(method));
 let forbiddenApiCalls=0;
 await page.route('**/api/**',async route=>{forbiddenApiCalls++;await route.abort();});
 await page.route('**/simulated-host',async route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><script>
 window.addEventListener('message',async(event)=>{const m=event.data;if(m?.jsonrpc!=='2.0')return;window.hostRecord(m.method);if(m.id===undefined)return;let result;if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Simulated host',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',displayMode:'inline'}};else if(m.method==='tools/call')result=await window.hostCallTool(m.params);else{event.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported fixture method'}},'*');return;}event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
 </script><iframe sandbox="allow-scripts allow-same-origin allow-forms" title="Swarmboard embedded app" src="/" style="width:100%;height:1000px;border:0"></iframe></body></html>`}));
 try{await page.goto('/simulated-host');const frame=page.frameLocator('iframe');await expect(frame.getByText('已连接',{exact:true})).toBeVisible();await frame.getByRole('button',{name:'新建任务',exact:true}).click();await frame.getByLabel('标题',{exact:true}).fill('Created through simulated host');await frame.getByRole('button',{name:'创建任务',exact:true}).click();await expect(frame.getByRole('button',{name:'查看任务 Created through simulated host',exact:true})).toBeVisible();expect(methods).toContain('ui/initialize');expect(methods).toContain('ui/notifications/initialized');expect(calls).toContain('board_read');expect(calls).toContain('task_create');expect(forbiddenApiCalls).toBe(0);const board=await(await request.get('/api/board')).json();expect(board.tasks.some((t:{title:string})=>t.title==='Created through simulated host')).toBe(true);}finally{await client.close();}
});
