import { openSettings, refreshBoard, closeSettings } from './settings-helpers.js';
// Validate visible workflows against the real service; no fixture data substitutes for persistence.
import {test,expect,type APIRequestContext} from '@playwright/test';
import type {Task,Resource} from '../../src/store.js';
async function readBoard(request:APIRequestContext):Promise<{tasks:Task[];resources:Resource[]}>{const response=await request.get('/api/board');expect(response.ok()).toBe(true);return response.json();}
test('three display columns preserve all persisted states and require an explicit pending drop choice',async({page,request})=>{
 const ids:Record<string,string>={};
 for(const status of ['todo','in_progress','in_review','done','blocked','canceled']){
  const response=await request.post('/api/tasks',{data:{title:`Column fixture ${status}`}});expect(response.ok()).toBe(true);const task=await response.json();ids[status]=task.id;
  if(status!=='todo')expect((await request.patch(`/api/tasks/${task.id}`,{data:{expectedVersion:1,status}})).ok()).toBe(true);
 }
 await page.goto('/');
 await expect(page.locator('.column-heading h2')).toHaveText(['待认领','进行中','待处理']);
 for(const status of ['todo','in_progress','in_review','blocked']){
  const group=status==='in_review'||status==='blocked'?'pending':status;
  await expect(page.locator(`[data-status="${group}"] [data-task-id="${ids[status]}"]`)).toBeVisible();
 }
 for(const status of ['done','canceled']){
  await expect(page.locator(`[data-status="${status}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-task-id="${ids[status]}"]`)).toHaveCount(0);
  expect((await readBoard(request)).tasks.find(task=>task.id===ids[status])).toMatchObject({status,version:2});
 }
 const pending=page.locator('[data-status="pending"]');
 const count=(await readBoard(request)).tasks.filter(task=>['in_review','blocked'].includes(task.status)).length;
 await expect(pending.locator('.column-heading > span')).toHaveText(String(count));
 for(const [status,label,color] of [['in_review','待验收','rgb(25, 135, 84)'],['blocked','受阻','rgb(220, 53, 69)']]){
  const card=pending.locator(`[data-card-id="${ids[status!]}"]`);
  await expect(card.getByRole('button')).toHaveAccessibleDescription(label!);
  await expect(card.locator('.task-state')).toHaveText(label!);
  await expect(card.locator('.task-state-dot')).toHaveCSS('background-color',color!);
 }
 const todo=page.locator(`[data-card-id="${ids.todo}"]`);
 await todo.dragTo(pending.locator('.column-list'));
 await expect(page.getByRole('dialog',{name:'选择待处理状态'})).toBeVisible();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 expect((await readBoard(request)).tasks.find(task=>task.id===ids.todo)).toMatchObject({status:'todo',version:1});
 await todo.dragTo(pending.locator('.column-list'));
 await page.getByRole('dialog').getByRole('button',{name:'受阻',exact:true}).click();
 await expect(pending.locator(`[data-task-id="${ids.todo}"]`)).toBeVisible();
 expect((await readBoard(request)).tasks.find(task=>task.id===ids.todo)).toMatchObject({status:'blocked',version:2});
 await pending.locator(`[data-card-id="${ids.in_review}"]`).dragTo(pending.locator('.column-list'));
 await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await readBoard(request)).tasks.find(task=>task.id===ids.in_review)).toMatchObject({status:'in_review',version:2});
 await pending.locator(`[data-card-id="${ids.todo}"]`).dragTo(page.locator('[data-drop-status="in_progress"]'));
 await expect(page.locator(`[data-status="in_progress"] [data-task-id="${ids.todo}"]`)).toBeVisible();
 expect((await readBoard(request)).tasks.find(task=>task.id===ids.todo)).toMatchObject({status:'in_progress',version:3});
 await page.reload();await expect(page.locator(`[data-status="in_progress"] [data-task-id="${ids.todo}"]`)).toBeVisible();
});
test('legacy resource records stay historical without a settings management entry',async({page,request})=>{
 const response=await request.post('/api/resources',{data:{name:'Browser legacy resource',kind:'machine',capabilities:['Linux']}});expect(response.ok()).toBe(true);const legacy=await response.json();
 await page.goto('/');await openSettings(page);
 await expect(page.getByRole('button',{name:'查看资源 Browser legacy resource',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'编辑资源 Browser legacy resource',exact:true})).toHaveCount(0);
 await expect(page.locator('.legacy-resources, .resource-grid')).toHaveCount(0);
 await expect(page.getByLabel('用户提示词内容',{exact:true})).not.toHaveValue(/Browser legacy resource/);
 expect((await readBoard(request)).resources.find(resource=>resource.id===legacy.id)).toEqual(legacy);
});
test('two browser sessions expose stale edit conflicts and explicitly reload before retry',async({page,browser,request})=>{
 const response=await request.post('/api/tasks',{data:{title:'Concurrent browser task'}});expect(response.ok()).toBe(true);const task=await response.json();
 const otherContext=await browser.newContext();const other=await otherContext.newPage();
 try{
  await Promise.all([page.goto('/'),other.goto(new URL('/', test.info().project.use.baseURL).href)]);
  for(const session of [page,other])await session.getByRole('button',{name:'查看任务 Concurrent browser task',exact:true}).click();
  await page.getByLabel('标题',{exact:true}).fill('Winning browser edit');await page.getByRole('button',{name:'保存修改'}).click();await expect(page.getByRole('button',{name:'查看任务 Winning browser edit',exact:true})).toBeVisible();
  await other.getByLabel('标题',{exact:true}).fill('Stale browser draft');const rejected=other.waitForResponse(result=>result.url().endsWith(`/api/tasks/${task.id}`)&&result.request().method()==='PATCH');
  await other.getByRole('button',{name:'保存修改'}).click();expect((await rejected).status()).toBe(409);await expect(other.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(other.getByLabel('标题',{exact:true})).toHaveValue('Stale browser draft');await expect(other.getByRole('button',{name:'保存修改'})).toBeDisabled();
  expect((await readBoard(request)).tasks.find(item=>item.id===task.id)).toMatchObject({title:'Winning browser edit',version:2});
  await other.getByRole('button',{name:'载入最新内容',exact:true}).click();await expect(other.getByLabel('标题',{exact:true})).toHaveValue('Winning browser edit');
  await other.getByLabel('任务说明').fill('Reconciled after reading latest');await other.getByRole('button',{name:'保存修改'}).click();await expect(other.getByRole('dialog')).toHaveCount(0);
  expect((await readBoard(request)).tasks.find(item=>item.id===task.id)).toMatchObject({title:'Winning browser edit',description:'Reconciled after reading latest',version:3});
 }finally{await otherContext.close();}
});
test('task editing, resource prompts, shared coordination, XSS and reload',async({page,request},testInfo)=>{
 const seeded=await request.post('/api/tasks',{data:{title:'Browser task',description:'<img src=x onerror="window.injected=true">',acceptanceCriteria:'Real browser check'}});expect(seeded.ok()).toBe(true);
 const creates:string[]=[];page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/tasks')creates.push(req.url());});
 await page.goto('/');await expect(page.getByRole('tab')).toHaveText(['任务管理','共享面板']);await expect(page.getByRole('button',{name:/新建任务|创建任务/})).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'查看任务 Browser task',exact:true})).toBeVisible();await page.getByRole('button',{name:'查看任务 Browser task',exact:true}).click();await page.getByLabel('标题',{exact:true}).fill('Edited browser task');await page.getByRole('dialog').getByRole('combobox').selectOption('in_review');await page.getByRole('button',{name:'保存修改'}).click();await expect(page.locator('[data-status="pending"]').getByRole('button',{name:'查看任务 Edited browser task',exact:true})).toBeVisible();const editedBoard=await(await request.get('/api/board')).json();expect(editedBoard.tasks.find((t:{title:string})=>t.title==='Edited browser task')).toMatchObject({status:'in_review',version:2});await page.screenshot({path:testInfo.outputPath('redesign-tasks.png'),fullPage:true});expect(await page.evaluate(()=>Boolean((window as unknown as {injected?:boolean}).injected))).toBe(false);expect(creates).toEqual([]);
 const created = await request.post('/api/resources',{data:{name:'Browser Alpha',accessNotes:'Coordinate before restart',description:'Shared compute'}});expect(created.ok()).toBe(true);
 await refreshBoard(page); await openSettings(page);
 await expect(page.locator('.legacy-resources, .resource-detail')).toHaveCount(0);
 const prompt='Browser Alpha: Shared compute. Coordinate before restart.';
 await page.getByLabel('用户提示词内容',{exact:true}).fill(prompt);
 await page.getByRole('button',{name:'保存用户提示词',exact:true}).click();
 await expect(page.getByLabel('当前保存的用户提示词')).toContainText(prompt);
 const post=async(path:string,data:unknown)=>{const response=await request.post(path,{data});expect(response.ok()).toBe(true);return response.json();};
 const a=await post('/api/agents',{name:'Browser Agent A'}), b=await post('/api/agents',{name:'Browser Agent B'});
 const board=await readBoard(request), resource=board.resources.find((r:{name:string})=>r.name==='Browser Alpha');
 if(!resource)throw new Error('Missing archival fixture');
 expect(resource).toMatchObject({kind:'',accessNotes:'Coordinate before restart',description:'Shared compute',version:1});
 await post('/api/entries',{agentId:a.id,kind:'CLAIM',summary:'Browser Alpha compile in isolated checkout',detail:'Use two cores; coordinate other uses in shared context.'});
 await post('/api/entries',{agentId:b.id,kind:'MESSAGE',summary:'Browser Alpha read logs concurrently',detail:'Read-only application logs; no restart.'});
 await post('/api/entries',{agentId:b.id,kind:'FACT',summary:'Browser verified finding',detail:'<script>window.injected=true</script>',resourceId:resource.id});
 await closeSettings(page); await page.getByRole('tab',{name:'共享面板',exact:true}).click(); await refreshBoard(page);
 await expect(page.getByText('Browser Alpha compile in isolated checkout',{exact:true})).toBeVisible();
 await expect(page.getByText('Browser Alpha read logs concurrently',{exact:true})).toBeVisible();
 const finding=page.locator('.shared-entry').filter({hasText:'Browser verified finding'});
 await expect(finding).toHaveCount(1); await expect(finding.getByText('事实',{exact:true})).toBeVisible();
 await expect(finding.getByRole('button',{name:/Browser Alpha/})).toHaveCount(0);
 await finding.getByText('展开详情',{exact:true}).click(); await expect(finding.locator('pre')).toHaveText('<script>window.injected=true</script>');
 await expect(page.getByText('只读',{exact:true})).toBeVisible(); await expect(page.getByRole('textbox')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/发布|发送|删除/})).toHaveCount(0);
 expect(await page.evaluate(()=>Boolean((window as unknown as {injected?:boolean}).injected))).toBe(false);
 await page.screenshot({path:testInfo.outputPath('redesign-shared.png'),fullPage:true});
 await page.reload(); await expect(page.getByRole('button',{name:'查看任务 Edited browser task',exact:true})).toBeVisible(); await openSettings(page);
 await expect(page.getByLabel('用户提示词内容',{exact:true})).toHaveValue(prompt);
 expect((await readBoard(request)).resources.find((r:{id:string})=>r.id===resource.id)).toEqual(resource);
});
test('keyboard task opening and saving, select editing, mobile tabs and escape remain usable',async({page,request})=>{const response=await request.post('/api/tasks',{data:{title:'Keyboard task'}});expect(response.ok()).toBe(true);await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('button',{name:'查看任务 Keyboard task',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByLabel('标题',{exact:true})).toBeFocused();await page.getByRole('combobox',{name:'状态',exact:true}).focus();await expect(page.getByRole('combobox',{name:'状态',exact:true})).toBeFocused();await page.getByRole('combobox',{name:'状态',exact:true}).selectOption('in_progress');await expect(page.getByRole('combobox',{name:'状态',exact:true})).toHaveValue('in_progress');await page.getByRole('button',{name:'保存修改'}).focus();await page.keyboard.press('Enter');await expect(page.locator('[data-status="in_progress"]').getByRole('button',{name:'查看任务 Keyboard task',exact:true})).toBeVisible();expect((await readBoard(request)).tasks.find(task=>task.title==='Keyboard task')).toMatchObject({status:'in_progress',version:2});await page.getByRole('tab',{name:'任务管理',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'共享面板',exact:true})).toBeFocused();await expect(page.getByRole('tab',{name:'共享面板',exact:true})).toHaveAttribute('aria-selected','true');await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'设置',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);});
