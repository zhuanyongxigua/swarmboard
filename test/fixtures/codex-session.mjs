#!/usr/bin/env node
// Model-free App Server peer exercises protocol races and approval failures
// without using a real login, model, board database or user workspace.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0;
// Turn ids started in this process, so thread/read can report real completed
// turns to clients that inspect by the turnId they received from turn/start.
const startedTurns = [];
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
    if (params.threadId === 'required-worker-thread' && !process.argv.includes('mcp_servers.swarmboard_worker.required=true')) { send({ id, error: { code: 412 } }); return; }
    if (params.threadId === 'delayed-resume-thread') {
      setTimeout(() => send({ id, result: { thread: { id: params.threadId, cwd: params.cwd } } }), 1200);
      return;
    }
    // Simulate unbounded history hydration stalling a metadata-only resume.
    if (method === 'thread/resume' && params.threadId === 'large-history-thread' && params.excludeTurns !== true) return;
    if (params.threadId === 'resume-timeout-thread') return;
    if (method === 'thread/start' && params.cwd.endsWith('/new-thread-timeout')) return;
    if (params.threadId === 'locked-thread') { send({ id, error: { code: -32600, message: 'thread locked-thread already has an active writer' } }); return; }
    if (params.threadId === 'private-error-thread') { send({ id, error: { code: -32603, message: 'private-token-value' } }); return; }
    send({ id, result: { thread: { id: params.threadId ?? 'persistent-thread', cwd: params.cwd } } });
  }
  if (method === 'thread/read') {
    const status = { 'failed-thread': 'failed', 'interrupted-thread': 'interrupted', 'active-thread': 'inProgress' }[params.threadId] ?? 'completed';
    const items = [{ type: params.threadId === 'assistant-only' ? 'agentMessage' : 'userMessage', content: [{ type: 'inputText', text: 'delivery-needle' }] }];
    const turns = [{ id: 'saved-turn', status, items }, ...startedTurns.map(id => ({ id, status: 'completed', items }))];
    send({ id, result: { thread: { turns: params.threadId === 'empty-thread' ? [] : turns } } });
  }
  if (method === 'turn/start') {
    const text = params.input[0].text;
    if (text === 'timeout') return;
    if (text === 'disconnect') { process.exit(0); }
    const tid = 'turn-' + (++turn);
    startedTurns.push(tid);
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
