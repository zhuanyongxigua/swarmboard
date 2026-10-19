// Exercise real SQLite durability, schema upgrades and transactional event consistency.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
describe('SQLite integration',()=>{
 it('migrates v4 owners into shared participants without changing task versions or append-only history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'swarmboard-v4-')),path=join(dir,'board.sqlite');
  try {
   const old=new Store(path);old.registerAgent({agentId:'legacy-peer',name:'Legacy peer'});const task=old.createTask({title:'Existing human goal'});
   old.claimTask(task.id,{agentId:'legacy-peer',expectedVersion:1});const history=old.board().entries;
   old.db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run('legacy-peer',task.id);
   // Reconstruct v4 rather than relabeling a database that still contains newer tables.
   old.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_progress; DROP TABLE board_overview; DROP TABLE board_preferences; DROP TABLE task_participants; PRAGMA user_version=4;');
   expect(old.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name)).toEqual(['agents','automation_bindings','automation_config','entries','resources','tasks','usages']);old.close();
   const upgraded=new Store(path);expect(upgraded.board().tasks[0]).toMatchObject({id:task.id,version:2,status:'in_progress',assignee:null,participants:['legacy-peer']});
   expect(upgraded.board().entries).toEqual(history);const snapshot=upgraded.board();upgraded.close();
   const reopened=new Store(path);expect(reopened.board()).toEqual(snapshot);reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('persists unclassified resources and retains legacy kind when edited after reopening',()=>{const dir=mkdtempSync(join(tmpdir(),'swarmboard-resource-'));const path=join(dir,'board.sqlite');try{const initial=new Store(path);const legacy=initial.createResource({name:'Existing machine',kind:'machine',capabilities:['Linux']});const plain=initial.createResource({name:'Shared directory'});initial.close();const edited=new Store(path);expect(edited.updateResource(legacy.id,{expectedVersion:1,description:'Updated by new UI'})).toMatchObject({kind:'machine',capabilities:['Linux'],version:2});edited.close();const reopened=new Store(path);expect(reopened.board().resources).toEqual(expect.arrayContaining([expect.objectContaining({id:plain.id,kind:'',version:1}),expect.objectContaining({id:legacy.id,kind:'machine',description:'Updated by new UI',version:2})]));reopened.close();}finally{rmSync(dir,{recursive:true,force:true});}});
 it('reopens durable tasks, resource declarations, agents and event cursors',()=>{const dir=mkdtempSync(join(tmpdir(),'swarmboard-'));try{let store=new Store(join(dir,'board.sqlite'));const a=store.registerAgent({name:'A'});const t=store.createTask({title:'Persist me'});const r=store.createResource({name:'Alpha',kind:'machine'});store.claimTask(t.id,{agentId:a.id,expectedVersion:1});store.declareUsage({agentId:a.id,resourceId:r.id,purpose:'build'});const snapshot=store.board();store.close();store=new Store(join(dir,'board.sqlite'));expect(store.board()).toEqual(snapshot);expect((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(9);store.close();}finally{rmSync(dir,{recursive:true,force:true});}});
 it('upgrades a real version-1 database and keeps existing declarations',()=>{const dir=mkdtempSync(join(tmpdir(),'swarmboard-upgrade-'));const path=join(dir,'db.sqlite');try{const first=new Store(path);const a=first.registerAgent({name:'A'}),r=first.createResource({name:'Alpha',kind:'machine'});const usage=first.declareUsage({agentId:a.id,resourceId:r.id,purpose:'existing'});first.db.exec('ALTER TABLE usages DROP COLUMN version; DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_progress; DROP TABLE board_overview; DROP TABLE board_preferences; DROP TABLE task_participants; DROP TABLE automation_bindings; DROP TABLE automation_config; PRAGMA user_version=1;');
  expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name)).toEqual(['agents','entries','resources','tasks','usages']);
  expect(first.db.prepare('PRAGMA table_info(usages)').all().map(row=>row.name)).not.toContain('version');
  first.close();const upgraded=new Store(path);expect(upgraded.board().usages[0]).toMatchObject({id:usage.id,version:1,active:true});upgraded.close();const reopened=new Store(path);expect(reopened.board().usages).toHaveLength(1);reopened.close();}finally{rmSync(dir,{recursive:true,force:true});}});
 it('rolls back domain writes when the corresponding append fails',()=>{const store=new Store();try{store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT,'injected failure'); END;");expect(()=>store.createTask({title:'must roll back'})).toThrow(/injected/);expect(store.board().tasks).toEqual([]);expect(store.board().entries).toEqual([]);store.db.exec('DROP TRIGGER reject_event');store.createTask({title:'works after rollback'});expect(()=>store.db.exec("UPDATE entries SET summary='tampered'" )).toThrow(/append-only/);expect(()=>store.db.exec('DELETE FROM entries')).toThrow(/append-only/);}finally{store.close();}});
 it('rejects future schemas without mutating them',()=>{const dir=mkdtempSync(join(tmpdir(),'swarmboard-newer-'));const path=join(dir,'db.sqlite');try{const db=new DatabaseSync(path);db.exec('PRAGMA user_version=99');db.close();expect(()=>new Store(path)).toThrow(/newer/);}finally{rmSync(dir,{recursive:true,force:true});}});
});
