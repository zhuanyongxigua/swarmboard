import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { AppError, Store, schemas } from './store.js';

export const BOARD_RESOURCE_URI = 'ui://swarmboard/board.html';
export function createMcpServer(store: Store, widgetPath: string) {
  const server = new McpServer({name:'swarmboard',version:'0.1.0'});
  registerAppResource(server, 'swarmboard-ui', BOARD_RESOURCE_URI, {}, async () => ({
    contents: [{uri:BOARD_RESOURCE_URI,mimeType:RESOURCE_MIME_TYPE,text:readFileSync(widgetPath,'utf8'),_meta:{ui:{prefersBorder:false,csp:{connectDomains:[],resourceDomains:[]}}}}],
  }));
  function success(result: unknown) {
    const structuredContent: Record<string, unknown> = Array.isArray(result) ? {items:result} : result as Record<string,unknown>;
    return {content:[{type:'text' as const,text:JSON.stringify(structuredContent)}],structuredContent};
  }
  function fail(error: unknown) {
    const known = error instanceof AppError;
    return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:{code:known ? error.code : 'INTERNAL_ERROR',message:known ? error.message : 'Unable to complete operation'}})}]};
  }
  const operations = [
    ['board_read','Read tasks, resources, agents, usage declarations and the latest shared context.',z.object({}).strict(),()=>store.board(),true],
    ['task_create','Create a task with a concrete goal and acceptance criteria.',schemas.taskCreate,(input:unknown)=>store.createTask(input),false],
    ['task_update','Update task content or status using its current version. Supply agentId for agent ownership checks; omit only for trusted human editing.',schemas.taskUpdate.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...patch}=input as {id:string};return store.updateTask(id,patch);},false],
    ['resource_create','Register a resource. Describe access instructions without credentials; resources are shareable.',schemas.resourceCreate,(input:unknown)=>store.createResource(input),false],
    ['resource_update','Edit resource information using its current version.',schemas.resourceUpdate.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...patch}=input as {id:string};return store.updateResource(id,patch);},false],
    ['agent_register','Register a unique agent identity for this trusted workspace. Keep its returned id for subsequent actions.',schemas.agent,(input:unknown)=>store.registerAgent(input),false],
    ['agent_heartbeat','Report agent liveness. This does not imply physical machine availability.',z.object({agentId:z.string().min(1)}).strict(),(input:unknown)=>store.heartbeat((input as {agentId:string}).agentId),false],
    ['task_claim','Atomically claim an unassigned available task and publish a claim entry.',schemas.claim.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...claim}=input as {id:string};return store.claimTask(id,claim);},false],
    ['task_release','Return your task to the queue or mark it blocked, clearing assignment and publishing an event. Use its latest version.',schemas.taskRelease.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...release}=input as {id:string};return store.releaseTask(id,release);},false],
    ['context_read','Read shared context incrementally with a bounded cursor. Save the returned cursor for the next read.',schemas.context,(input:unknown)=>store.readEntries(input),true],
    ['context_publish','Publish an append-only observation, verified fact, failure, claim, patch summary, or message. Explain resource sharing with peers here.',schemas.entry,(input:unknown)=>store.publishEntry(input),false],
    ['resource_use','Declare intended resource use with scope and sharing conditions. Multiple active declarations are allowed; coordinate with peers.',schemas.usage,(input:unknown)=>store.declareUsage(input),false],
    ['resource_usage_update','Amend your active usage declaration after negotiating sharing conditions.',schemas.usageUpdate.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...patch}=input as {id:string};return store.updateUsage(id,patch);},false],
    ['resource_release','Release your own resource-use declaration. Does not stop OS processes or affect other agents.',schemas.release.extend({id:z.string().min(1)}),(input:unknown)=>{const {id,...release}=input as {id:string};return store.releaseUsage(id,release);},false],
  ] as const;
  for (const [name,description,schema,operation,readOnly] of operations) {
    server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:false}},async (input: unknown)=>{
      try{return success(operation(input));}catch(error){return fail(error);}
    });
  }
  registerAppTool(server,'board_open',{description:'Open the Swarmboard workspace with task, resource, and read-only shared context panels.',inputSchema:{},_meta:{ui:{resourceUri:BOARD_RESOURCE_URI}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async()=>success(store.board()));
  server.registerPrompt('shared_worker',{description:'Agensh-inspired cooperation loop for an existing official agent session.',argsSchema:{agentId:z.string().optional(),target:z.string().optional()}},async({agentId,target})=>({messages:[{role:'user',content:{type:'text',text:`You are ${agentId ?? 'an agent; register with agent_register first'} in a trusted shared workspace. Target: ${target ?? 'read the board for team goals'}. Register your identity with agent_register before acting; if that identity already exists, resume it with agent_heartbeat. Follow gather -> claim -> act -> verify -> merge. Read relevant tasks, context and active resource-use declarations; choose useful work, claim with the latest version, announce scope and dependencies, and negotiate overlapping work with peers. Resource declarations are not exclusive reservations: describe your intended use and agree on sharing conditions. Work using your existing authorized harness and external workspace; this server does not execute code or host Git. Publish verified findings and failed approaches, link evidence in task descriptions and PATCH_SUMMARY entries, update task status, use task_release when abandoning an unfinished task so another agent can claim it, release your resource declarations with their latest versions when finished, and heartbeat while active. Read context incrementally, avoid empty polling, and report blockers honestly. Do not copy subscription credentials into this service.`}}]}));
  return server;
}
