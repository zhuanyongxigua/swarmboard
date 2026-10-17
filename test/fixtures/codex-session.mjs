#!/usr/bin/env node
// Model-free App Server peer exercises protocol races and approval failures
// without using a real login, model, board database or user workspace.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0;
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
    send({ id, result: { thread: { id: params.threadId ?? 'persistent-thread', cwd: params.cwd } } });
  }
  if (method === 'thread/read') send({ id, result: { thread: { turns: [{ id: 'saved-turn', status: 'completed' }] } } });
  if (method === 'turn/start') {
    const text = params.input[0].text;
    if (text === 'timeout') return;
    if (text === 'disconnect') { process.exit(0); }
    const tid = 'turn-' + (++turn);
    if (text === 'early') send({ method: 'turn/completed', params: { turn: { id: tid, status: 'completed' } } });
    send({ id, result: { turn: { id: tid } } });
    if (text === 'approval') send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    else if (text !== 'early') send({ method: 'turn/completed', params: { turn: { id: tid, status: 'completed' } } });
  }
});
