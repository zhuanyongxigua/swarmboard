// Preserve unknown/corrupt admission data as an error instead of reporting a known-empty external cohort.
import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCollaboratorSnapshot } from '../../src/collaborators.js';

test('genuinely missing admission table reads empty without creating a table', () => {
  const dir=mkdtempSync(join(tmpdir(),'p8-admissions-')); const path=join(dir,'state.sqlite');
  try {
    const db=new DatabaseSync(path); db.close();
    expect(readCollaboratorSnapshot(path)).toEqual([]);
    const verify=new DatabaseSync(path,{readOnly:true});
    try { expect(verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]); }
    finally { verify.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('malformed row mentioning no such table is not mistaken for a missing table', () => {
  const dir=mkdtempSync(join(tmpdir(),'p8-admissions-')); const path=join(dir,'state.sqlite');
  try {
    const db=new DatabaseSync(path);
    db.exec('CREATE TABLE external_collaborators(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    db.prepare('INSERT INTO external_collaborators VALUES(?,?)').run('corrupt','no such table'); db.close();
    expect(() => readCollaboratorSnapshot(path)).toThrow(SyntaxError);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
