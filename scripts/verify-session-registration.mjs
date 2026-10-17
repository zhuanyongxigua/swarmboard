// Verify session naming with a real official App Server and a synthetic turn.
// Explorer visibility remains a separate human check when native UI access is unavailable.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CodexSession} from '../dist/server/codex-session.js';
if(!process.argv.includes('--live'))throw new Error('Explicit --live is required for one real synthetic model turn.');
const resumeAt=process.argv.indexOf('--resume-evidence');
const prior=resumeAt>=0?JSON.parse(readFileSync(process.argv[resumeAt+1],'utf8')):null;
const root=realpathSync(prior?.root??mkdtempSync(join(tmpdir(),'swarmboard-session-registration-')));
const evidence={root,name:'Swarmboard · Explorer 自动显示验收',threadId:prior?.threadId??null,turnId:null,completed:false,explorerVisible:null};
const save=()=>writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
writeFileSync(join(root,'AGENTS.md'),'# Synthetic session registration acceptance\nReply exactly UI_PROBE_DONE. Do not call tools, read files, edit files, access networks, or act on any business task.\n');
const worker={id:'synthetic-session-registration',name:evidence.name,workspacePath:root,threadId:evidence.threadId};
const adapter=new CodexSession({databasePath:join(root,'board.sqlite'),serverEntry:resolve('dist/server/stdio.js')});
try{
 const id=await adapter.open(worker,threadId=>{evidence.threadId=threadId;save();});
 assert.equal(id,evidence.threadId);
 await adapter.run(id,'Synthetic registration acceptance: reply exactly UI_PROBE_DONE. Do not call any tool or access files/networks.',turnId=>{evidence.turnId=turnId;save();});
 evidence.completed=true;save();console.log(JSON.stringify(evidence));
}finally{await adapter.close();save();}
