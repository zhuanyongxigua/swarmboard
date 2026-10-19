// Rebuild public product screenshots from the actual UI and synthetic board data,
// keeping the user's collaboration database and real development machines untouched.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { screenshotCopy } from './readme-copy.mjs';
import { startServer } from '../dist/server/app.js';
import { createMcpServer } from '../dist/server/mcp.js';
import { EventRuntime } from '../dist/server/event-runtime.js';
import { Store } from '../dist/server/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function capture(locale) {
  const copy = text => screenshotCopy(locale, text);
  const temporary = await mkdtemp(path.join(tmpdir(), 'swarmboard-readme-'));
  const output = path.join(root, 'docs/assets', locale);
  const widgetPath = path.join(root, 'dist/widget.html');
  const dbPath = path.join(temporary, 'board.sqlite');
  let service, client, overviewClient, overviewServer, browser, runtime, store;
  try {
    // The overview needs a runtime fact source, so build a disposable one. It is
    // never started: no watcher, scan, native adapter or model turn may run.
    store = new Store(dbPath);
    let sessionAttempts = 0;
    runtime = new EventRuntime(store, {
      databasePath: dbPath, serverEntry: 'unused', debounceMs: 600000,
      adapter: () => { sessionAttempts += 1; throw new Error('README fixture must not dispatch a session'); },
    });
    const pool = runtime.configurePool({ workspacePath: temporary, size: 2 });
    const memberIds = [];
    for (const name of ['readme-sample-native-a', 'readme-sample-native-b']) {
      const workspacePath = path.join(temporary, name);
      await mkdir(workspacePath);
      const worker = runtime.workers.register({ name, workspacePath });
      runtime.workers.save({ ...worker, poolId: pool.id });
      store.registerAgent({ agentId: worker.id, name });
      memberIds.push(worker.id);
    }
    runtime.workers.savePool({ ...pool, memberIds });
    service = await startServer({ port: 0, host: '127.0.0.1', store, runtime, boardToken: '', widgetPath });
    client = new Client({ name: 'readme-synthetic-preview', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`)));
    // Author the overview through the real bound MCP surface with the current
    // facts revision, preferences version and CAS version, never direct SQLite.
    const [overviewClientTransport, overviewServerTransport] = InMemoryTransport.createLinkedPair();
    overviewServer = createMcpServer(store, widgetPath, runtime, { poolMember: true, workerId: memberIds[0], mayAct: () => true });
    await overviewServer.connect(overviewServerTransport);
    overviewClient = new Client({ name: 'readme-synthetic-member', version: '1.0.0' });
    await overviewClient.connect(overviewClientTransport);
    async function callOverview(name, args = {}) {
      const result = await overviewClient.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`Screenshot overview fixture failed: ${name}`);
      return result.structuredContent;
    }
    async function call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`Screenshot fixture failed: ${name}`);
      return result.structuredContent;
    }
    const agents = [
      ['demo-login', copy("Agent · 登录回归")],
      ['demo-files', copy("Agent · 文件预览")],
      ['demo-ui', copy("Agent · 界面修复")],
    ];
    for (const [agentId, name] of agents) await call('agent_register', { agentId, name });
    const machine = await call('resource_create', { name: 'dev-a', description: copy("共享开发环境 · 不同页面可并行验证"), accessNotes: copy("独立账号与工作目录；重启服务前先协商。") });
    await call('resource_create', { name: 'dev-b', description: copy("备用开发环境 · 适合构建与独立验证"), accessNotes: copy("开始前声明使用范围，结束后释放声明。") });
    await call('resource_create', { name: copy("回归数据集"), description: copy("登录与文件功能的示例测试数据"), accessNotes: copy("可并行读取；变更共用数据前通知其他使用者。") });
    const search = await call('task_create', { title: copy("补全搜索结果的空状态"), description: copy("没有匹配结果时，给出清晰提示和下一步操作。"), acceptanceCriteria: copy("空列表和搜索无结果两种情况均有提示。") });
    await call('task_claim', { id: search.id, agentId: 'demo-ui', expectedVersion: 1 });
    await call('task_create', { title: copy("为文件上传增加失败重试"), description: copy("保留失败文件，让用户可以直接重试。"), acceptanceCriteria: copy("重试成功后不会产生重复文件。") });
    const login = await call('task_create', { title: copy("回归登录与权限校验"), description: copy("检查正常登录、错误密码和页面权限提示。"), acceptanceCriteria: copy("登录和权限用例均有可核对的结果。") });
    await call('task_claim', { id: login.id, agentId: 'demo-login', expectedVersion: 1 });
    const files = await call('task_create', { title: copy("验证文件预览与下载"), description: copy("覆盖文档预览、文件下载与异常提示。"), acceptanceCriteria: copy("支持格式可预览，下载内容与原件一致。") });
    await call('task_claim', { id: files.id, agentId: 'demo-files', expectedVersion: 1 });
    // Seed reported estimates through the real Store contract, never by
    // elapsed time, member count or a task-status-to-percentage mapping.
    for (const [task, agentId, progress] of [
      [login, 'demo-login', { percent: 70, state: 'active', phase: copy("检查结果核对"), verified: copy("已记录合成登录检查结果。"), remaining: copy("完成示例验收。") }],
      [files, 'demo-files', { percent: 35, state: 'waiting', phase: copy("等待示例审核"), verified: copy("文件预览示例已准备。"), remaining: copy("等待示例接收人确认。") }],
      [search, 'demo-ui', { percent: null, state: 'unknown', phase: copy("正在整理检查范围"), verified: '', remaining: copy("核对示例验收范围。") }],
    ]) {
      service.store.writeTaskProgress(task.id, { agentId, expectedVersion: service.store.readTask(task.id).version, progress });
    }
    const review = await call('task_create', { title: copy("修复分页切换后的选中状态"), description: copy("翻页后清除旧页面的选中项，等待人工验收。"), acceptanceCriteria: copy("翻页后计数和操作对象保持一致。") });
    await call('task_claim', { id: review.id, agentId: 'demo-ui', expectedVersion: 1 });
    await call('task_update', { id: review.id, agentId: 'demo-ui', expectedVersion: 2, status: 'in_review' });
    const done = await call('task_create', { title: copy("整理回归结果与复现步骤"), description: copy("汇总检查记录，让后续处理可以直接复现问题。"), acceptanceCriteria: copy("每项记录包含操作步骤与预期结果。") });
    await call('task_claim', { id: done.id, agentId: 'demo-ui', expectedVersion: 1 });
    await call('task_update', { id: done.id, agentId: 'demo-ui', expectedVersion: 2, status: 'done' });
    await call('resource_use', { resourceId: machine.id, agentId: 'demo-login', taskId: login.id, purpose: copy("验证登录与权限提示"), scope: copy("独立浏览器会话 / 示例账号 A"), sharing: copy("可并行；不重启服务，不修改共用配置。") });
    await call('resource_use', { resourceId: machine.id, agentId: 'demo-files', taskId: files.id, purpose: copy("验证文件预览与下载"), scope: copy("独立浏览器会话 / 示例账号 B"), sharing: copy("可与登录回归同时进行；数据变更前先沟通。") });
    // These records illustrate the workflow; they are not statements by actual model sessions.
    const detail = copy("文档截图示例数据；不对应实际模型执行、测试结果或代码提交。");
    await call('context_publish', { agentId: 'demo-ui', kind: 'PATCH_SUMMARY', taskId: done.id, summary: copy("回归记录已整理，操作步骤与预期结果放在一起。"), detail });
    await call('context_publish', { agentId: 'demo-ui', kind: 'FACT', taskId: review.id, summary: copy("分页选中状态的修改已提交，等待验收。"), detail });
    await call('context_publish', { agentId: 'demo-login', kind: 'MESSAGE', resourceId: machine.id, taskId: login.id, summary: copy("准备验证登录流程，使用独立账号，不重启服务。"), detail });
    await call('context_publish', { agentId: 'demo-files', kind: 'MESSAGE', recipientId: 'demo-login', resourceId: machine.id, summary: copy("我同时检查文件预览，使用另一组账号，不改登录配置。"), detail });
    await call('context_publish', { agentId: 'demo-login', kind: 'OBSERVED', resourceId: machine.id, summary: copy("两项检查使用不同账号和浏览器会话，可以共用 dev-a。"), detail });
    await call('context_publish', { agentId: 'demo-files', kind: 'MESSAGE', recipientId: 'demo-login', resourceId: machine.id, summary: copy("约定：如需重启服务，先通知当前使用者，确认检查结束后再操作。"), detail });
    // The note identifies itself as documentation data: only registered native
    // members are factual; activity and model identity stay unknown because this
    // fixture starts no runtime owner and never dispatches a model.
    const overviewFactsView = await callOverview('overview_read');
    expect(overviewFactsView.status).toBe('missing');
    expect(overviewFactsView.facts.available).toBe(true);
    const factValues = new Map(overviewFactsView.facts.items.map(item => [item.id, item.value]));
    expect(factValues.get('native.members')).toBe(memberIds.length);
    expect(factValues.get('native.running')).toBeNull();
    expect(factValues.get('external.model')).toBeNull();
    const preferences = await call('preferences_read');
    const overviewNote = copy("文档示例：");
    const writtenOverview = await callOverview('overview_write', {
      expectedVersion: overviewFactsView.record?.version ?? 0,
      factsRevision: overviewFactsView.facts.revision,
      preferencesVersion: preferences.version, ttlSeconds: 900,
      parts: [
        { kind: 'text', text: overviewNote },
        { kind: 'text', text: copy("原生登记") },
        { kind: 'fact', factId: 'native.members' },
        { kind: 'text', text: copy("· 外部模型") },
        { kind: 'fact', factId: 'external.model' },
      ],
    });
    expect(writtenOverview.status).toBe('current');
    await mkdir(output, { recursive: true });
    // An explicitly named local channel avoids downloading a bundled browser on
    // hosts that already have Chrome; the default remains Playwright's choice.
    browser = await chromium.launch(process.env.SWARMBOARD_SCREENSHOT_BROWSER_CHANNEL
      ? { channel: process.env.SWARMBOARD_SCREENSHOT_BROWSER_CHANNEL } : {});
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', locale, timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1 });
    async function checkLanguage() {
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      if (locale === 'en') expect(await page.locator('body').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.evaluate(() => document.fonts.ready);
    }
    await page.goto(`${service.url}/?lang=${locale}`);
    await expect(page.getByRole('button', { name: copy("查看任务 回归登录与权限校验"), exact: true })).toBeVisible();
    const overview = page.getByRole('region', { name: copy("协作概览"), exact: true });
    await expect(overview).toContainText(overviewNote);
    await expect(overview.locator('strong')).toHaveText([String(memberIds.length), copy("未知")]);
    await expect(page.getByRole('button', { name: copy("停止协作"), exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy("恢复协作"), exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy("增加成员"), exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy("减少成员"), exact: true })).toBeVisible();
    await expect(overview.locator('details, dl, small, [title]')).toHaveCount(0);
    // A short, explicitly synthetic overview must occupy one row at desktop
    // width; narrow-screen wrapping is covered by the direct browser suite.
    const overviewHeight = await overview.evaluate(element => ({
      actual: element.getBoundingClientRect().height,
      line: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(overviewHeight.actual).toBeLessThanOrEqual(overviewHeight.line + 2);
    await expect(page.locator('.task-card')).toHaveCount(6);
    await expect(page.locator('.task-progress')).toHaveCount(3);
    for (const [state, percent] of [['active', 70], ['waiting', 35], ['unknown', null]]) {
      const progress = page.locator(`.task-progress[data-progress-state="${state}"]`);
      await expect(progress).toBeVisible();
      const bar = progress.getByRole('progressbar');
      if (percent === null) {
        await expect(bar).not.toHaveAttribute('aria-valuenow');
        await expect(progress.locator('.task-progress-unknown')).toBeVisible();
        await expect(progress.locator('.task-progress-fill')).toHaveCount(0);
      } else {
        await expect(bar).toHaveAttribute('aria-valuenow', String(percent));
        await expect(progress.locator('.task-progress-percent')).toHaveText(`${percent}%`);
      }
    }
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'tasks.png') });
    // Capture both collaboration-environment sections from the combined product UI.
    await page.getByRole('tab', { name: new RegExp(`^(?:${copy("资源池")}|${copy("协作环境")})$`) }).click();
    await expect(page.locator('.resource-row')).toHaveCount(3);
    await expect(page.locator('.preferences-panel')).toBeVisible();
    await expect(page.getByRole('heading', { name: copy("个人偏好"), exact: true })).toBeVisible();
    await expect(page.locator('.preference-text')).toHaveText(copy("尚无个人偏好。"));
    await expect(page.locator('#preference-text')).toHaveValue('');
    await page.getByRole('button', { name: copy("查看资源 dev-a"), exact: true }).click();
    await expect(page.locator('.usage-line')).toHaveCount(2);
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'resources.png'), fullPage: true });
    await page.getByRole('tab', { name: copy("共享面板"), exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(copy("约定：如需重启服务，先通知当前使用者，确认检查结束后再操作。"), { exact: true })).toBeVisible();
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'shared.png') });
    // Starting no runtime owner must also mean zero native/model dispatch attempts.
    expect(sessionAttempts).toBe(0);
    console.log(`README screenshots captured in ${locale} from real UI and isolated sample data.`);
  } finally {
    await browser?.close();
    await client?.close();
    await overviewClient?.close();
    await overviewServer?.close();
    await service?.close();
    await runtime?.close();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
for (const locale of ['en', 'zh-CN']) await capture(locale);
