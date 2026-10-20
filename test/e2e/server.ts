// Give browser tests an isolated real service and database with automatic teardown.
import { rmSync } from 'node:fs';import {basename,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';import {startServer} from '../../src/app.js';
const dbPath=process.env.SWARMBOARD_TEST_DB_PATH;if(!dbPath)throw new Error('Missing isolated browser database');
const dir=dirname(dbPath);if(resolve(dirname(dir))!==resolve(tmpdir())||!basename(dir).startsWith('swarmboard-browser-'))throw new Error('Unsafe fixture cleanup directory');const server=await startServer({port:Number(process.env.SWARMBOARD_TEST_PORT??4318),dbPath});
process.on('SIGTERM',()=>{void server.close().then(()=>{rmSync(dir,{recursive:true,force:true});process.exit(0);});});
