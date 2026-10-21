// Compare real SQLite/MCP principals without model calls or a live organization.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { createMcpServer } from '../../src/mcp.js';
import { collaboratorRole } from '../../src/collaborators.js';
import { NotificationService } from '../../src/notification-service.js';
let root: string, board: Store, runtime: EventRuntime, nativeId: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
 root=mkdtempSync(join(tmpdir(),'swarmboard-equality-'));
 mkdirSync(join(root,'.git'));mkdirSync(join(root,'.git/objects'));mkdirSync(join(root,'.git/refs'));writeFileSync(join(root,'.git/HEAD'),'ref: refs/heads/main\n'); writeFileSync(join(root,'.git/config'),'[remote "origin"]\n url = https://gitlab.example.test/group/project.git\n');
 board=new Store(join(root,'board.sqlite'));
 runtime=new EventRuntime(board,{databasePath:join(root,'board.sqlite'),serverEntry:'unused',adapter:()=>({open:async()=>{throw Error('No models')},run:async()=>{},close:async()=>{}})});
 const pool=runtime.configurePool({workspacePath:root,size:1,maxSize:3});
 const native=runtime.workers.register({name:'Native',workspacePath:root}); nativeId=native.id;
 runtime.workers.save({...native,poolId:pool.id});runtime.workers.savePool({...pool,memberIds:[nativeId]});board.registerAgent({agentId:nativeId,name:'Native'});
});
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();await runtime.close();board.close();rmSync(root,{recursive:true,force:true})});
async function connect(id:string, external=false){
 const role=external?collaboratorRole(board,runtime.collaborators,id,runtime.workers):{mayAct:()=>runtime.workers.pool()!.enabled};
 const server=createMcpServer(board,'unused',undefined,{poolMember:!external,collaborator:external,workerId:id,peers:runtime.workers,ci:runtime.ci,...(external?{collaboratorId:id,collaborators:runtime.collaborators}:{}),...role});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'equal-principal-fixture',version:'1'});await client.connect(b);
 cleanup.push(async()=>{await client.close();await server.close()});return client;
}
const call=(c:Client,name:string,args:Record<string,unknown>={})=>c.callTool({name,arguments:args});
const data=(r:Awaited<ReturnType<typeof call>>)=>{expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent as any};
const admit=(taskIds:string[],extra:Record<string,unknown>={})=>runtime.configureCollaborator({expectedVersion:0,name:'External',harness:'dsh',taskIds,enabled:true,...extra});
it('requires an explicit organization choice, preserves legacy selected scope and discovers future goals after opt-in',async()=>{
 const first=board.createTask({title:'Existing'});expect(()=>admit([])).toThrow(/taskIds/);
 expect(()=>admit([],{scope:'organization',poolId:'wrong-pool'})).toThrow(/organization/i);
 const legacy=admit([first.id]);const selected=await connect(legacy.id,true);
 const member=admit([],{scope:'organization',poolId:runtime.workers.pool()!.id});const external=await connect(member.id,true);const native=await connect(nativeId);
 const second=board.createTask({title:'Later human goal'});
 expect(data(await call(selected,'task_list')).items.map((t:any)=>t.id)).toEqual([first.id]);
 for(const c of [native,external])expect(data(await call(c,'task_list')).items.map((t:any)=>t.id)).toEqual([first.id,second.id]);
 const n=(await native.listTools()).tools.map(t=>t.name).sort(),e=(await external.listTools()).tools.map(t=>t.name).sort();expect(e.filter(name => !name.startsWith('notification_'))).toEqual(n);
 expect(e.filter(name => name.startsWith('notification_'))).toEqual(['notification_binding_read', 'notification_pending', 'notification_receipt', 'notification_register']);
 expect(e).toEqual(expect.arrayContaining(['peer_request','pipeline_watch','execution_grants_read']));expect(e).not.toContain('collaborator_configure');
 data(await call(external,'context_publish',{agentId:member.id,taskId:second.id,kind:'CLAIM',summary:'Independent contribution'}));
 const task=board.readTask(second.id);expect(task.participants).toContain(member.id);
 data(await call(external,'task_progress_update',{agentId:member.id,id:second.id,expectedVersion:task.version,progress:{percent:20,phase:'Review',remaining:'Implementation',state:'active',verified:'Fixture evidence'}}));
});
it('treats an empty scope intersection as no goals across list, board, history, writes and infrastructure',async()=>{
 const a=board.createTask({title:'A'}),b=board.createTask({title:'B'});const member=admit([a.id],{poolId:runtime.workers.pool()!.id});const c=await connect(member.id,true);
 board.publishEntry({agentId:nativeId,taskId:a.id,kind:'FACT',summary:'A evidence'});board.publishEntry({agentId:nativeId,taskId:b.id,kind:'FACT',summary:'B evidence'});
 const pool=runtime.workers.pool()!;runtime.workers.savePool({...pool,taskIds:[b.id]});
 expect(data(await call(c,'task_list')).items).toEqual([]);expect(data(await call(c,'board_read')).tasks).toEqual([]);
 expect(data(await call(c,'context_read')).items.filter((e:any)=>e.taskId)).toEqual([]);
 for(const [name,args] of [['task_read',{id:a.id}],['context_publish',{agentId:member.id,taskId:a.id,kind:'CLAIM',summary:'Cannot widen'}],['peer_request',{requestId:'none',reason:'No admitted work'}],['pipeline_watch',{taskId:a.id,pipelineId:1,sha:'a'.repeat(40)}]] as const)expect((await call(c,name,args)).isError).toBe(true);
});
it('isolates directed messages equally in history, compact snapshots, searches and attached updates',async()=>{
 const goal=board.createTask({title:'Goal'}),member=admit([],{scope:'organization',poolId:runtime.workers.pool()!.id});
 board.registerAgent({agentId:'third',name:'Third'});const native=await connect(nativeId),external=await connect(member.id,true);
 board.publishEntry({agentId:nativeId,taskId:goal.id,kind:'MESSAGE',recipientId:'third',summary:'Private marker'});
 board.publishEntry({agentId:'third',taskId:goal.id,kind:'MESSAGE',recipientId:member.id,summary:'External direct'});
 for(const c of [native,external])for(const [name,args] of [['context_read',{}],['context_search',{query:'Private marker'}],['board_read',{}]] as const)expect(JSON.stringify(await call(c,name,args))).not.toContain('Private marker');
 expect(JSON.stringify(data(await call(external,'context_read')))).toContain('External direct');
});
it('binds peer requests, CI and grant reads to the real external principal and current scope',async()=>{
 const goal=board.createTask({title:'Goal'}),outside=board.createTask({title:'Outside'});const member=admit([goal.id],{poolId:runtime.workers.pool()!.id});const c=await connect(member.id,true);
 expect(data(await call(c,'peer_request',{requestId:'extra',reason:'Independent work'})).size).toBe(2);
 expect(data(await call(c,'peer_request',{requestId:'extra',reason:'Same request'})).size).toBe(2);
 expect(runtime.workers.list()).toHaveLength(1);expect(runtime.workers.db.prepare('SELECT workerId FROM peer_requests').get()).toEqual({workerId:member.id});
 expect((await call(c,'context_publish',{agentId:nativeId,taskId:goal.id,kind:'FACT',summary:'Spoof'})).isError).toBe(true);
 expect(data(await call(c,'pipeline_watch',{taskId:goal.id,pipelineId:1,sha:'a'.repeat(40)}))).toMatchObject({taskId:goal.id,host:'gitlab.example.test',project:'group/project'});
 expect((await call(c,'pipeline_watch',{taskId:outside.id,pipelineId:2,sha:'b'.repeat(40)})).isError).toBe(true);
 for(const taskId of [goal.id,outside.id])runtime.configureExecutionGrant({taskId,expectedVersion:0,projectPath:root,executionWorkspace:root,externalHarnesses:['dsh'],monitoring:true,enabled:true});
 expect(data(await call(c,'execution_grants_read')).grants.map((g:any)=>g.taskId)).toEqual([goal.id]);
 runtime.configureCollaborator({id:member.id,expectedVersion:1,name:member.name,harness:member.harness,taskIds:[outside.id],enabled:true});
 expect(data(await call(c,'execution_grants_read')).grants.map((g:any)=>g.taskId)).toEqual([outside.id]);
 expect((await call(c,'pipeline_watch',{taskId:goal.id,pipelineId:3,sha:'c'.repeat(40)})).isError).toBe(true);
 const pool=runtime.workers.pool()!;runtime.workers.savePool({...pool,enabled:false});expect((await call(c,'peer_request',{requestId:'stop',reason:'No'})).isError).toBe(true);
 runtime.workers.savePool(pool);runtime.configureCollaborator({id:member.id,expectedVersion:2,name:member.name,harness:member.harness,taskIds:[outside.id],enabled:false});
 expect((await call(c,'execution_grants_read')).isError).toBe(true);expect((await call(c,'peer_request',{requestId:'revoked',reason:'No'})).isError).toBe(true);
});
it.each(['task_claim', 'execution_grants_read', 'peer_request', 'pipeline_watch'])('rechecks current goals before %s after a stale completed snapshot', async name => {
 const first = board.createTask({ title: 'Finished goal' });
 const member = admit([], { scope: 'organization', poolId: runtime.workers.pool()!.id });
 const external = await connect(member.id, true);
 board.updateTask(first.id, { expectedVersion: first.version, status: 'done' });
 const pool = runtime.workers.pool()!;
 runtime.workers.savePool({ ...pool, state: 'completed' });
 expect(collaboratorRole(board, runtime.collaborators, member.id, runtime.workers).mayAct()).toBe(false);
 const next = board.createTask({ title: 'New human goal' });
 runtime.configureExecutionGrant({ taskId: next.id, expectedVersion: 0, projectPath: root, executionWorkspace: root, externalHarnesses: ['dsh'], monitoring: true, enabled: true });
 const args = name === 'task_claim' ? { id: next.id, expectedVersion: next.version, agentId: member.id }
  : name === 'peer_request' ? { requestId: 'new-goal', reason: 'New independent contribution' }
  : name === 'pipeline_watch' ? { taskId: next.id, pipelineId: 1, sha: 'a'.repeat(40) } : {};
 data(await call(external, name, args));
 expect(runtime.workers.pool()!.state).toBe('completed'); // No runtime owner or implicit pool mutation.
 for (const state of ['stopping', 'stopped'] as const) {
  runtime.workers.savePool({ ...pool, state });
  expect(collaboratorRole(board, runtime.collaborators, member.id, runtime.workers).mayAct()).toBe(false);
  expect((await call(external, name, args)).isError).toBe(true);
 }
 runtime.workers.savePool({ ...pool, state: 'completed', enabled: false });
 expect(collaboratorRole(board, runtime.collaborators, member.id, runtime.workers).mayAct()).toBe(false);
});
it('validates notification declarations against the current organization scope', () => {
 const member = admit([], { scope: 'organization', poolId: runtime.workers.pool()!.id, sessionRef: 'notification-session' });
 const goal = board.createTask({ title: 'Future organization goal' });
 const other = board.createTask({ title: 'Other human goal' });
 const service = new NotificationService(board, runtime.collaborators, runtime.workers);
 const declaration = { id: 'organization-channel', version: 1, displayName: 'External channel', harness: 'fixture', enabled: true,
  capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] };
 expect(service.register(member.id, declaration).members[0]!.taskIds).toEqual([goal.id]);
 const pool = runtime.workers.pool()!;
 runtime.workers.savePool({ ...pool, taskIds: [other.id] });
 expect(() => service.register(member.id, { ...declaration, version: 2 })).toThrow(/exceeds admitted tasks/);
 expect(service.register(member.id, { ...declaration, version: 2, members: [{ ...declaration.members[0]!, taskIds: [other.id] }] }).version).toBe(2);
 runtime.workers.savePool({ ...pool, id: 'replacement-organization' });
 expect(() => service.register(member.id, { ...declaration, version: 3 })).toThrow(/exceeds admitted tasks/);
});
