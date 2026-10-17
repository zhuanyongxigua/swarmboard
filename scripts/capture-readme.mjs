// Rebuild public product screenshots from the actual UI and synthetic MCP data,
// keeping the user's collaboration database and real development machines untouched.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { screenshotCopy } from './readme-copy.mjs';
import { startServer } from '../dist/server/app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function capture(locale) {
  const copy = text => screenshotCopy(locale, text);
  const temporary = await mkdtemp(path.join(tmpdir(), 'swarmboard-readme-'));
  const output = path.join(root, 'docs/assets', locale);
  let service, client, browser;
  try {
    service = await startServer({ port: 0, host: '127.0.0.1', dbPath: path.join(temporary, 'board.sqlite'), boardToken: '', widgetPath: path.join(root, 'dist/widget.html') });
    client = new Client({ name: 'readme-synthetic-preview', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`)));
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
    await call('task_create', { title: copy("补全搜索结果的空状态"), description: copy("没有匹配结果时，给出清晰提示和下一步操作。"), acceptanceCriteria: copy("空列表和搜索无结果两种情况均有提示。") });
    await call('task_create', { title: copy("为文件上传增加失败重试"), description: copy("保留失败文件，让用户可以直接重试。"), acceptanceCriteria: copy("重试成功后不会产生重复文件。") });
    const login = await call('task_create', { title: copy("回归登录与权限校验"), description: copy("检查正常登录、错误密码和页面权限提示。"), acceptanceCriteria: copy("登录和权限用例均有可核对的结果。") });
    await call('task_claim', { id: login.id, agentId: 'demo-login', expectedVersion: 1 });
    const files = await call('task_create', { title: copy("验证文件预览与下载"), description: copy("覆盖文档预览、文件下载与异常提示。"), acceptanceCriteria: copy("支持格式可预览，下载内容与原件一致。") });
    await call('task_claim', { id: files.id, agentId: 'demo-files', expectedVersion: 1 });
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
    await mkdir(output, { recursive: true });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', locale, timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1 });
    async function checkLanguage() {
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      if (locale === 'en') expect(await page.locator('body').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`${service.url}/?lang=${locale}`);
    await expect(page.getByRole('button', { name: copy("查看任务 回归登录与权限校验"), exact: true })).toBeVisible();
    await expect(page.locator('.task-card')).toHaveCount(6);
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'tasks.png') });
    await page.getByRole('tab', { name: copy("资源池"), exact: true }).click();
    await expect(page.locator('.resource-row')).toHaveCount(3);
    await page.getByRole('button', { name: copy("查看资源 dev-a"), exact: true }).click();
    await expect(page.locator('.usage-line')).toHaveCount(2);
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'resources.png') });
    await page.getByRole('tab', { name: copy("共享面板"), exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(copy("约定：如需重启服务，先通知当前使用者，确认检查结束后再操作。"), { exact: true })).toBeVisible();
    await checkLanguage();
    await page.screenshot({ path: path.join(output, 'shared.png') });
    console.log(`README screenshots captured in ${locale} from real UI and isolated sample data.`);
  } finally {
    await browser?.close();
    await client?.close();
    await service?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
for (const locale of ['en', 'zh-CN']) await capture(locale);
