#!/usr/bin/env node
// Model-free App Server peer exercises protocol races and approval failures
// without using a real login, model, board database or user workspace.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0;
const threads = new Map();
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === 'approval') send({ method: 'turn/completed', params: { turn: { id: 'turn-' + turn, status: message.error ? 'completed' : 'failed' } } });
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'thread/start' || method === 'thread/resume') {
    if (params.sandbox !== 'workspace-write' || params.approvalPolicy !== 'on-request') { send({ id, error: { code: 400 } }); return; }
    // Simulate unbounded history hydration stalling a metadata-only resume.
    if (method === 'thread/resume' && params.threadId === 'large-history-thread' && params.excludeTurns !== true) return;
    const threadId=params.threadId??'persistent-thread';
    const thread=threads.get(threadId)??{id:threadId,cwd:params.cwd,name:threadId==='custom-name-thread'?'Human chosen title':null};
    threads.set(threadId,thread);send({ id, result: { thread } });
  }
  if (method === 'thread/name/set') {
    if(params.threadId==='name-failure-thread'){send({id,error:{code:409}});return;}
    if(params.threadId==='name-timeout-thread')return;
    threads.get(params.threadId).name=params.name;
    send({method:'thread/name/updated',params:{threadId:params.threadId,threadName:params.name}});send({id,result:{}});
  }
  if (method === 'thread/read') {
    if(params.includeTurns===false){const thread=threads.get(params.threadId);send({id,result:{thread:params.threadId==='unverified-name-thread'?{...thread,name:'wrong name'}:thread}});return;}
    const status = { 'failed-thread': 'failed', 'interrupted-thread': 'interrupted', 'active-thread': 'inProgress' }[params.threadId] ?? 'completed';
    const items = [{ type: params.threadId === 'assistant-only' ? 'agentMessage' : 'userMessage', content: [{ type: 'inputText', text: 'delivery-needle' }] }];
    send({ id, result: { thread: { turns: params.threadId === 'empty-thread' ? [] : [{ id: 'saved-turn', status, items }] } } });
  }
  if (method === 'turn/start') {
    const text = params.input[0].text;
    if(text==='require-named-session'&&threads.get(params.threadId)?.name!=='Swarmboard · peer 4'){send({id,error:{code:409}});return;}
    if(text==='require-custom-name'&&threads.get(params.threadId)?.name!=='Human chosen title'){send({id,error:{code:409}});return;}
    if (text === 'timeout') return;
    if (text === 'disconnect') { process.exit(0); }
    const tid = 'turn-' + (++turn);
    if (text === 'early') send({ method: 'turn/completed', params: { turn: { id: tid, status: 'completed' } } });
    send({ id, result: { turn: { id: tid } } });
    if (text === 'disconnect-after-ack') { setTimeout(() => process.exit(0), 20); return; }
    if (text === 'wrong-completion') {
      send({ method: 'turn/completed', params: { turn: { id: 'unrelated-turn', status: 'completed' } } });
      setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: tid, status: 'failed' } } }), 20);
      return;
    }
    if (text === 'duplicate') send({ method: 'turn/completed', params: { turn: { id: tid, status: 'completed' } } });
    if (text === 'approval') send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    else if (text !== 'early') send({ method: 'turn/completed', params: { turn: { id: tid, status: 'completed' } } });
  }
});
