// Give browser tests an isolated real service and database with automatic teardown.
import { mkdtempSync,rmSync } from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {startServer} from '../../src/app.js';
const dir=mkdtempSync(join(tmpdir(),'swarmboard-browser-'));const server=await startServer({port:4318,dbPath:join(dir,'board.sqlite')});
process.on('SIGTERM',()=>{void server.close().then(()=>{rmSync(dir,{recursive:true,force:true});process.exit(0);});});
