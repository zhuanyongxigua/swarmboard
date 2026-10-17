import { locale, t } from './i18n.js';
import type { AutomationConfig } from '../src/automation.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import './style.css';
import { appendNativeDraft, nativeConversationUnavailableReason, startNativeAutomationSetup, taskDiscussionPrompt } from './native-conversation.js';

type Task = {
  id: string; title: string; description: string; acceptanceCriteria: string;
  status: string; assignee: string | null; version: number; updatedAt: string;
};
type Resource = {
  id: string; name: string; kind: string; description: string;
  capabilities: string[]; accessNotes: string; version: number;
};
type Agent = { id: string; name: string; lastSeenAt: string };
type Entry = {
  id: number; kind: string; agentId: string; summary: string; detail: string;
  taskId?: string; resourceId?: string; recipientId?: string; createdAt: string;
};
type Usage = {
  id: string; resourceId: string; agentId: string; purpose: string; scope: string;
  sharing: string; taskId?: string; active: boolean;
};
type Board = { tasks: Task[]; resources: Resource[]; agents: Agent[]; usages: Usage[]; entries: Entry[]; cursor: number };
type Editor = { type: 'task'; item?: Task } | { type: 'resource'; item?: Resource };
type Tab = 'tasks' | 'resources' | 'shared';


const statuses: Record<string, string> = {
  todo: t("待认领"), in_progress: t("进行中"), in_review: t("待验收"),
  done: t("已完成"), blocked: t("受阻"), canceled: t("已取消"),
};
const entryKinds: Record<string, string> = {
  OBSERVED: t("观察"), FACT: t("事实"), FAIL: t("失败经验"),
  CLAIM: t("工作声明"), PATCH_SUMMARY: t("成果摘要"), MESSAGE: t("消息"),
};
const tabs: { id: Tab; title: string }[] = [
  { id: 'tasks', title: t("任务管理") },
  { id: 'resources', title: t("资源池") },
  { id: 'shared', title: t("共享面板") },
];
let bridge: App | null = null;

class OperationError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
function operationError(error?: { code?: string; message?: string }) {
  return new OperationError(error?.code === 'VERSION_CONFLICT'
    ? t("内容已被其他参与者更新。看板将刷新，请核对最新内容后重试。")
    : error?.message ?? t("操作未完成，请检查连接后重试。"), error?.code);
}
function message(error: unknown) { return error instanceof Error ? error.message : t("操作未完成，请重试。"); }
function unpack(value: unknown): unknown {
  const result = value as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  let data = result.structuredContent;
  if (!data) {
    const content = result.content?.find(item => item.type === 'text');
    if (content?.text) {
      try { data = JSON.parse(content.text); }
      catch { data = { error: { message: content.text } }; }
    }
  }
  if (result.isError) throw operationError((data as { error?: { code?: string; message?: string } })?.error);
  return data;
}
async function operation<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (bridge) return unpack(await bridge.callServerTool({ name, arguments: args })) as T;
  if (window.parent !== window) throw new OperationError(t("插件尚未连接桌面宿主，请重新打开面板后重试。"));
  let url = '/api/board';
  let method = 'GET';
  let body: Record<string, unknown> | undefined;
  const { id, ...patch } = args;
  if (name === 'task_create') { url = '/api/tasks'; method = 'POST'; body = args; }
  if (name === 'task_update') { url = `/api/tasks/${encodeURIComponent(String(id))}`; method = 'PATCH'; body = patch; }
  if (name === 'resource_create') { url = '/api/resources'; method = 'POST'; body = args; }
  if (name === 'resource_update') { url = `/api/resources/${encodeURIComponent(String(id))}`; method = 'PATCH'; body = patch; }
  const response = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw operationError(data.error);
  return data as T;
}
function RichText({ value }: { value: string }) {
  return <>{value.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    : <React.Fragment key={index}>{part}</React.Fragment>)}</>;
}
function time(value: string, full = false) {
  return new Date(value).toLocaleString(locale, full
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false });
}
function shortId(id: string) { return id.length > 12 ? `${id.slice(0, 8)}…` : id; }

function Workspace() {
  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState<Tab>('tasks');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [updated, setUpdated] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [automation, setAutomation] = useState<AutomationConfig | null>(null);
  const [automationReadError, setAutomationReadError] = useState('');
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [nativeUnavailable, setNativeUnavailable] = useState(window.parent === window
    ? t("HTTP 预览不提供原生对话，请在 ChatGPT 桌面端打开插件。")
    : t("正在连接原生对话宿主…"));
  const [nativePending, setNativePending] = useState(false);
  const [nativeFeedback, setNativeFeedback] = useState('');
  const [nativeFeedbackTaskId, setNativeFeedbackTaskId] = useState<string | null>(null);
  const [nativeFailed, setNativeFailed] = useState(false);
  const nativeBusy = useRef(false);
  const mounted = useRef(true);
  const dragged = useRef<Task | null>(null);
  const moving = useRef(false);

  const readAutomation = useCallback(async () => {
    if (!bridge) return;
    try {
      const config = await operation<AutomationConfig>('automation_read');
      if (mounted.current) { setAutomation(config); setAutomationReadError(''); }
    } catch (error) {
      if (mounted.current) setAutomationReadError(message(error));
    }
  }, []);

  const refresh = useCallback(async (quiet = false): Promise<Board | null> => {
    if (!quiet) setRefreshing(true);
    try {
      const data = await operation<Board>('board_read');
      void readAutomation();
      if (mounted.current) {
        setBoard(data); setError(''); setUpdated(new Date().toISOString());
      }
      return data;
    } catch (error) {
      if (mounted.current) setError(message(error));
      return null;
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [readAutomation]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let localBridge: App | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function start() {
      try {
        if (window.parent !== window) {
          const app = new App({ name: 'Swarmboard', version: '0.4.0' });
          localBridge = app;
          app.ontoolresult = result => {
            try {
              const data = unpack(result) as Board;
              if (data?.tasks && data?.resources && active) {
                setBoard(data); setLoading(false); setUpdated(new Date().toISOString());
              }
            } catch (error) { if (active) setError(message(error)); }
          };
          app.onhostcontextchanged = () => {
            if (active) setNativeUnavailable(nativeConversationUnavailableReason(app.getHostCapabilities(), app.getHostContext()?.platform));
          };
          await app.connect();
          if (!active) return;
          bridge = app;
          setConnected(true);
          setNativeUnavailable(nativeConversationUnavailableReason(app.getHostCapabilities(), app.getHostContext()?.platform));
        }
        await refresh();
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh(true);
        }, 15000);
      } catch (error) {
        if (active) { setLoading(false); setError(message(error)); setNativeUnavailable(t("原生对话连接未完成，请重新打开插件后重试。")); }
      }
    }
    void start();
    return () => {
      active = false; mounted.current = false;
      if (timer) clearInterval(timer);
      if (bridge === localBridge) bridge = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (!automationOpen || !connected) return;
    void readAutomation();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void readAutomation(); }, 3000);
    return () => clearInterval(timer);
  }, [automationOpen, connected, readAutomation]);

  const name = (id: string) => id === 'human' ? t("空间管理者") : board?.agents.find(agent => agent.id === id)?.name ?? id;
  const stale = (id: string) => {
    const agent = board?.agents.find(agent => agent.id === id);
    return Boolean(agent && Date.now() - Date.parse(agent.lastSeenAt) > 120000);
  };
  const usages = board?.usages.filter(usage => usage.active) ?? [];

  async function discuss(task: Task) {
    if (!bridge || !board || nativeBusy.current || nativeUnavailable) return;
    nativeBusy.current = true; setNativePending(true); setNativeFeedback(''); setNativeFailed(false);
    setNativeFeedbackTaskId(task.id);
    try {
      await appendNativeDraft(bridge, taskDiscussionPrompt(task));
      if (mounted.current) setNativeFeedback(t("已追加到原生对话草稿，请检查后发送。"));
    } catch (error) {
      if (mounted.current) {
        setNativeFailed(true);
        setNativeFeedback(`${t('无法追加到原生对话草稿：')}${message(error)}`);
      }
    } finally {
      nativeBusy.current = false;
      if (mounted.current) setNativePending(false);
    }
  }
  const nativeHelp = nativeUnavailable || t("将讨论提示追加到原生对话草稿，由你检查后发送。");
  const nativeDisabled = Boolean(nativeUnavailable || nativePending || !board);
  function changeTab(next: Tab) { setTab(next); }
  function tabKey(event: React.KeyboardEvent, index: number) {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2
      : (index + (event.key === 'ArrowRight' ? 1 : 2)) % tabs.length;
    changeTab(tabs[next].id);
    document.getElementById(`tab-${tabs[next].id}`)?.focus();
  }
  function openTask(taskId: string) {
    const task = board?.tasks.find(task => task.id === taskId);
    if (task) { setTab('tasks'); setEditor({ type: 'task', item: task }); }
  }
  function openResource(resourceId: string) {
    if (!board?.resources.some(resource => resource.id === resourceId)) return;
    setTab('resources'); setExpandedResource(resourceId);
    requestAnimationFrame(() => document.getElementById(`resource-${resourceId}`)?.focus());
  }
  async function moveTask(task: Task, status: string) {
    if (task.status === status || moving.current) return;
    moving.current = true; setMovingId(task.id); setError('');
    try {
      await operation('task_update', { id: task.id, status, expectedVersion: task.version });
      await refresh(true);
      setAnnouncement(`${task.title} ${t('已移至')} ${statuses[status] ?? status}`);
    } catch (error) {
      await refresh(true);
      setError(`${t('未能移动')} ${task.title}: ${message(error)}`);
      setAnnouncement(t("移动未完成，请查看错误提示。"));
    } finally { moving.current = false; setMovingId(null); }
  }
  function drop(event: React.DragEvent, status: string) {
    if (!dragged.current) return;
    event.preventDefault();
    const task = dragged.current;
    dragged.current = null;
    void moveTask(task, status);
  }
  async function reloadEditor(): Promise<boolean> {
    const data = await refresh(true);
    if (!data || !editor?.item) return false;
    const latest = editor.type === 'task'
      ? data.tasks.find(item => item.id === editor.item?.id)
      : data.resources.find(item => item.id === editor.item?.id);
    if (!latest) return false;
    setEditor(editor.type === 'task' ? { type: 'task', item: latest as Task } : { type: 'resource', item: latest as Resource });
    return true;
  }

  return <div className="workspace">
    <header className="workspace-header">
      <h1>Swarmboard</h1>
      <nav className="tabs" role="tablist" aria-label={t("工作面板")}>
        {tabs.map((item, index) => <button key={item.id} type="button" role="tab"
          id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`}
          tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => tabKey(event, index)}
          onClick={() => changeTab(item.id)}>{item.title}</button>)}
      </nav>
      <span className="connection" title={updated ? `${t('上次同步')} ${time(updated, true)}` : t("等待连接")}>
        {error ? t("同步需检查") : connected ? t("已连接") : t("本地空间")}
      </span>
      <button className="secondary automation-button" type="button" onClick={() => setAutomationOpen(true)}>{t("自动认领")}</button>
      <button className="refresh-button" type="button" aria-label={t("刷新面板")}
        disabled={refreshing} onClick={() => void refresh()}>↻</button>
    </header>
    <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      <div className="panel-toolbar">
        <span className="subtle">{tab === 'tasks' ? `${board?.tasks.length ?? 0} ${t('个任务')}`
          : tab === 'resources' ? `${board?.resources.length ?? 0} ${t('项资源')}` : t("Agent 交互记录")}</span>
        {tab === 'tasks' ? <button className="primary" type="button" onClick={() => setEditor({ type: 'task' })}>{t("新建任务")}</button>
          : tab === 'resources' ? <button className="primary" type="button" onClick={() => setEditor({ type: 'resource' })}>{t("添加资源")}</button>
            : <span className="subtle">{t("只读")}</span>}
      </div>
      {error && <div className="error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>{t("重试")}</button></div>}
      {loading ? <Empty title={t("正在读取协作空间")} text={t("获取任务、资源与最新共享记录…")} loading />
        : !board ? <Empty title={t("协作空间暂未连接")} text={t("恢复连接后可查看已有任务、资源与共享记录。")} />
          : tab === 'tasks' ? <TaskBoard board={board} usages={usages} name={name} stale={stale}
            movingId={movingId} open={task => setEditor({ type: 'task', item: task })}
            dragStart={(event, task) => {
              if (moving.current) { event.preventDefault(); return; }
              dragged.current = task;
              event.dataTransfer.setData('text/plain', task.id);
              event.dataTransfer.effectAllowed = 'move';
            }} dragEnd={() => { dragged.current = null; }}
            dragOver={event => { if (dragged.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} drop={drop} />
            : tab === 'resources' ? <ResourcePool board={board} usages={usages} name={name} stale={stale}
              expanded={expandedResource} toggle={id => setExpandedResource(current => current === id ? null : id)}
              edit={resource => setEditor({ type: 'resource', item: resource })} />
              : <SharedFeed board={board} name={name} openTask={openTask} openResource={openResource} />}
    </main>
    <div className="sr-only" aria-live="polite">{announcement}</div>
    {automationOpen && <AutomationDialog config={automation} readError={automationReadError}
      unavailable={nativeUnavailable} read={readAutomation} close={() => setAutomationOpen(false)}
      changed={config => setAutomation(config)} />}
    {editor && <EditorDialog key={`${editor.type}-${editor.item?.id ?? 'new'}-${editor.item?.version ?? 0}`}
      editor={editor} name={name} usages={usages} resources={board?.resources ?? []}
      close={() => setEditor(null)} saved={() => { setEditor(null); setAnnouncement(t("修改已保存。")); void refresh(true); }}
      failed={() => refresh(true)} reload={reloadEditor}
      nativeDisabled={nativeDisabled} nativeHelp={nativeHelp} nativePending={nativePending}
      nativeFeedback={nativeFeedbackTaskId === editor.item?.id ? nativeFeedback : ''}
      nativeFailed={nativeFailed} discuss={task => void discuss(task)} />}
  </div>;
}

function AutomationDialog({ config, readError, unavailable, read, close, changed }: {
  config: AutomationConfig | null; readError: string; unavailable: string; read: () => Promise<void>;
  close: () => void; changed: (config: AutomationConfig) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const busy = useRef(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!config || initialized.current) return;
    initialized.current = true;
    setWorkspacePath(config.workspacePath); setIntervalMinutes(config.intervalMinutes);
  }, [config]);
  const blocked = Boolean(unavailable || readError || !config || pending);
  const recovery = Boolean(config && (config.recoveryRequired || config.state === 'pending'));
  const fieldsLocked = blocked || recovery;
  const isAbsolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(workspacePath.trim());
  async function setup(action: 'enable' | 'pause' | 'reconcile') {
    if (!bridge || !config || blocked || busy.current || (recovery && action !== 'reconcile')) return;
    if (action === 'enable' && !isAbsolute) { setError(t("请输入工作目录的绝对路径。")); return; }
    busy.current = true; setPending(true); setError(''); setNotice('');
    let prepared: AutomationConfig | undefined;
    try {
      const result = await operation<{ config: AutomationConfig; setupPrompt: string }>('automation_prepare', {
        action, expectedVersion: config.version,
        ...(action === 'enable' ? { workspacePath: workspacePath.trim(), intervalMinutes } : {}),
      });
      prepared = result.config; changed(result.config);
      await startNativeAutomationSetup(bridge, result.setupPrompt);
      setNotice(t("配置请求已发送到新原生会话，等待宿主确认；消息发送成功不代表自动认领已启用或暂停。"));
    } catch (error) {
      const detail = message(error);
      setError(detail);
      if (prepared?.requestId) {
        try {
          changed(await operation<AutomationConfig>('automation_setup_failed', {
            expectedVersion: prepared.version, requestId: prepared.requestId, error: detail,
          }));
        } catch { await read(); }
      } else { await read(); }
    } finally { busy.current = false; setPending(false); }
  }
  const status = !config ? t("尚未读取状态") : config.state === 'pending'
    ? config.setupMode === 'reconcile' ? t("等待核对宿主状态") : config.desiredEnabled ? t("等待宿主确认启用") : t("等待宿主确认暂停")
    : config.state === 'error' ? t("配置失败") : config.state === 'active' ? t("已启用") : t("未启用");
  return <dialog ref={dialog} className="automation-dialog" aria-labelledby="automation-title"
    onCancel={event => { if (pending) event.preventDefault(); else close(); }}
    onClick={event => { if (event.target === dialog.current && !pending) close(); }}>
    <form onSubmit={event => { event.preventDefault(); void setup(recovery ? 'reconcile' : 'enable'); }}>
      <div className="dialog-header"><h2 id="automation-title">{t("自动认领")}</h2>
        <button className="close-button" type="button" aria-label={t("关闭自动认领设置")} disabled={pending} onClick={close}>×</button></div>
      <div className="form-body">
        <div className="automation-status" role="status"><span>{t("状态")}</span><strong>{status}</strong></div>
        {config?.actualStatus && <p className="form-note">{t("配置会话最后报告：")}{config.actualStatus === 'ACTIVE' ? t("运行中") : t("已暂停")}
          {config.automationId && <span className="automation-id">{config.automationId}</span>}</p>}
        <p className="form-note">{t("通过新原生会话配置宿主定时自动化，独立认领待办任务。默认关闭，不占用当前会话草稿。")}</p>
        <p className="form-note">{t("工作目录必须已添加为桌面应用中的本地项目。")}</p>
        <label>{t("工作目录")}<input name="workspacePath" placeholder="/path/to/project" autoComplete="off"
          value={workspacePath} disabled={fieldsLocked} onChange={event => setWorkspacePath(event.target.value)} /></label>
        <label>{t("检查间隔")}<select name="intervalMinutes" value={intervalMinutes} disabled={fieldsLocked}
          onChange={event => setIntervalMinutes(Number(event.target.value))}>
          {[5, 10, 15, 30, 60].map(value => <option key={value} value={value}>{value} {t("分钟")}</option>)}
        </select></label>
        {recovery && <p className="form-note">{t("先检查之前的配置会话。核对仅查询宿主，不会创建或修改自动化；核对完成后再明确启用或暂停。")}</p>}
        {unavailable && <p className="form-note">{t("自动认领需要支持原生消息的桌面宿主。")}</p>}
        {(error || readError || config?.lastError) && <div className="error dialog-error" role="alert"><span>{error || readError || config?.lastError}</span></div>}
        {notice && <p className="form-note" role="status">{notice}</p>}
      </div>
      <div className="dialog-actions">
        <button className="secondary" type="button" disabled={pending || Boolean(unavailable)} onClick={() => void read()}>{t("刷新状态")}</button>
        {config?.automationId && <button className="secondary" type="button" disabled={fieldsLocked || config.actualStatus !== 'ACTIVE'} onClick={() => void setup('pause')}>{t("在新会话中暂停")}</button>}
        <button className="primary" type="submit" disabled={blocked || (!recovery && !isAbsolute)}>{pending ? t("正在发送…") : recovery ? t("核对宿主状态") : config?.actualStatus === 'ACTIVE' ? t("在新会话中更新") : t("在新会话中启用")}</button>
      </div>
    </form>
  </dialog>;
}

function TaskBoard({ board, usages, name, stale, movingId, open, dragStart, dragEnd, dragOver, drop }: {
  board: Board; usages: Usage[]; name: (id: string) => string; stale: (id: string) => boolean;
  movingId: string | null; open: (task: Task) => void;
  dragStart: (event: React.DragEvent, task: Task) => void; dragEnd: () => void;
  dragOver: (event: React.DragEvent) => void; drop: (event: React.DragEvent, status: string) => void;
}) {
  const order = ['todo', 'in_progress', 'in_review', 'done'];
  for (const task of board.tasks) if (!order.includes(task.status)) order.push(task.status);
  return <div className="task-board" aria-label={t("任务状态看板")} style={{ '--column-count': order.length } as React.CSSProperties}>
    {order.map(status => {
      const tasks = board.tasks.filter(task => task.status === status);
      return <section className="task-column" key={status} aria-label={statuses[status] ?? status}
        data-status={status} onDragOver={dragOver} onDrop={event => drop(event, status)}>
        <div className="column-heading"><h2>{statuses[status] ?? status}</h2><span>{tasks.length}</span></div>
        <div className="column-list" data-drop-status={status}>
          {tasks.length ? tasks.map(task => {
            const related = [...new Set(usages.filter(usage => usage.taskId === task.id).map(usage => usage.resourceId))]
              .map(id => board.resources.find(resource => resource.id === id)?.name ?? id);
            return <button type="button" key={task.id} className="task-card" draggable={movingId === null}
              data-task-id={task.id} aria-label={`${t('查看任务')} ${task.title}`} disabled={movingId === task.id}
              onClick={() => open(task)} onDragStart={event => dragStart(event, task)} onDragEnd={dragEnd}>
              <span className="task-id" title={task.id}>{shortId(task.id)}</span>
              <span className="task-title">{task.title}</span>
              {task.description && <span className="task-excerpt">{task.description}</span>}
              <span className="task-footer">
                <span>{task.assignee ? name(task.assignee) : t("未认领")}
                  {task.assignee && stale(task.assignee) && <span className="stale"> {t("· 最近未报告")}</span>}</span>
                <span>{related.length ? related.join(locale === 'en' ? ', ' : '、') : t("暂无活跃资源声明")}</span>
              </span>
            </button>;
          }) : <p className="column-empty">{t("暂无任务")}</p>}
        </div>
      </section>;
    })}
  </div>;
}

function ResourcePool({ board, usages, name, stale, expanded, toggle, edit }: {
  board: Board; usages: Usage[]; name: (id: string) => string; stale: (id: string) => boolean;
  expanded: string | null; toggle: (id: string) => void; edit: (resource: Resource) => void;
}) {
  if (!board.resources.length) return <Empty title={t("暂无资源")} text={t("添加资源名称、说明与使用约定，供 Agents 协商使用。")} />;
  return <div className="resources">
    <div className="resource-grid table-heading" aria-hidden="true"><span>{t("名称与说明")}</span><span>{t("使用声明")}</span><span>{t("使用约定")}</span></div>
    {board.resources.map(resource => {
      const declarations = usages.filter(usage => usage.resourceId === resource.id);
      const isExpanded = expanded === resource.id;
      return <section className="resource-item" key={resource.id}>
        <button className="resource-grid resource-row" type="button" id={`resource-${resource.id}`}
          aria-label={`${t('查看资源')} ${resource.name}`} aria-expanded={isExpanded} aria-controls={`usage-${resource.id}`}
          onClick={() => toggle(resource.id)}>
          <span><span className="resource-name">{resource.name}</span><span className="resource-description">{resource.description || t("暂无说明")}</span></span>
          <span className="usage-summary">{declarations.length
            ? declarations.map(usage => <span key={usage.id}>{name(usage.agentId)} · {usage.purpose}</span>)
            : t("暂无活跃使用声明")}</span>
          <span className="subtle resource-agreement">{resource.accessNotes || t("暂无使用约定")}</span>
        </button>
        {isExpanded && <div className="resource-detail" id={`usage-${resource.id}`}>
          <div className="resource-detail-heading"><p className="subtle">{t("使用声明供协作参考，不代表独占或机器实际空闲。")}</p>
            <button className="secondary" type="button" aria-label={`${t('编辑资源')} ${resource.name}`} onClick={() => edit(resource)}>{t("编辑资源")}</button></div>
          {declarations.length ? declarations.map(usage => <div className="usage-line" key={usage.id}>
            <div>{name(usage.agentId)}{stale(usage.agentId) && <p className="stale">{t("最近未报告 · 使用待核实")}</p>}</div>
            <div><p>{usage.purpose}</p><p><span>{t("范围：")}</span><RichText value={usage.scope || t("未说明")} /></p>
              <p><span>{t("共享约定：")}</span><RichText value={usage.sharing || t("未说明")} /></p></div>
          </div>) : <p className="subtle">{t("尚无 Agent 声明使用这项资源，实际使用情况仍需核实。")}</p>}
        </div>}
      </section>;
    })}
  </div>;
}

function SharedFeed({ board, name, openTask, openResource }: {
  board: Board; name: (id: string) => string; openTask: (id: string) => void; openResource: (id: string) => void;
}) {
  if (!board.entries.length) return <Empty title={t("暂无共享记录")} text={t("Agents 发布工作声明、发现或消息后，会显示在这里。")} />;
  return <div className="shared-feed" aria-label={t("Agent 交互记录")}>
    {board.entries.slice().reverse().map(entry => <article className="shared-entry" key={entry.id}>
      <time dateTime={entry.createdAt} title={time(entry.createdAt, true)}>{time(entry.createdAt)}</time>
      <div className="entry-author"><span>{name(entry.agentId)}</span><span className="entry-kind">{entryKinds[entry.kind] ?? entry.kind}</span></div>
      <div className="entry-content"><p><RichText value={entry.summary} /></p>
        <div className="entry-references">
          {entry.taskId && <button type="button" className="reference-button" onClick={() => openTask(entry.taskId!)}>
            {t("任务 ·")} {board.tasks.find(task => task.id === entry.taskId)?.title ?? shortId(entry.taskId)}</button>}
          {entry.resourceId && <button type="button" className="reference-button" onClick={() => openResource(entry.resourceId!)}>
            {t("资源 ·")} {board.resources.find(resource => resource.id === entry.resourceId)?.name ?? shortId(entry.resourceId)}</button>}
          {entry.recipientId && <span className="subtle">{t("发送给 ·")} {name(entry.recipientId)}</span>}
        </div>
        {entry.detail && <details className="entry-details"><summary>{t("展开详情")}</summary><pre>{entry.detail}</pre></details>}
      </div>
    </article>)}
    <p className="feed-note">{t("最近")} {board.entries.length} {t("条记录 · 只读")}</p>
  </div>;
}

function Empty({ title, text, loading = false }: { title: string; text: string; loading?: boolean }) {
  return <div className="empty" role={loading ? 'status' : undefined}><h2>{title}</h2><p>{text}</p></div>;
}

function EditorDialog({ editor, name, usages, resources, close, saved, failed, reload,
  nativeDisabled, nativeHelp, nativePending, nativeFeedback, nativeFailed, discuss }: {
  editor: Editor; name: (id: string) => string; usages: Usage[]; resources: Resource[];
  close: () => void; saved: () => void; failed: () => Promise<Board | null>; reload: () => Promise<boolean>;
  nativeDisabled: boolean; nativeHelp: string; nativePending: boolean; nativeFeedback: string;
  nativeFailed: boolean; discuss: (task: Task) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const isTask = editor.type === 'task';
  const item = editor.item;
  const task = isTask ? editor.item : undefined;
  const resource = editor.type === 'resource' ? editor.item : undefined;
  const title = isTask ? item ? t("任务详情") : t("新建任务") : item ? t("编辑资源") : t("添加资源");
  const related = task ? [...new Set(usages.filter(usage => usage.taskId === task.id).map(usage => usage.resourceId))]
    .map(id => resources.find(resource => resource.id === id)?.name ?? id) : [];

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); first.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || conflict) return;
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const args: Record<string, unknown> = isTask
      ? { title: value('title'), description: value('description'), acceptanceCriteria: value('acceptanceCriteria') }
      : { name: value('name'), description: value('description'), accessNotes: value('accessNotes') };
    if (item) {
      args.id = item.id; args.expectedVersion = item.version;
      if (isTask) args.status = value('status');
    }
    setSaving(true); setError('');
    try {
      await operation(`${isTask ? 'task' : 'resource'}_${item ? 'update' : 'create'}`, args);
      saved();
    } catch (error) {
      const isConflict = error instanceof OperationError && error.code === 'VERSION_CONFLICT';
      setConflict(isConflict);
      setError(message(error));
      await failed();
    } finally { setSaving(false); }
  }
  async function reloadLatest() {
    setSaving(true);
    if (!await reload()) { setError(t("暂时无法载入最新内容，请检查连接后重试。")); setSaving(false); }
  }

  return <dialog ref={dialog} aria-labelledby="editor-title"
    onCancel={event => { if (saving) event.preventDefault(); else close(); }}
    onClick={event => { if (event.target === dialog.current && !saving) close(); }}>
    <form onSubmit={event => void submit(event)}>
      <div className="dialog-header"><h2 id="editor-title">{title}</h2>
        <button type="button" className="close-button" aria-label={t("关闭编辑窗口")} disabled={saving} onClick={close}>×</button></div>
      <div className="form-body">
        {isTask ? <>
          {task && <div className="task-discussion">
            <div className="task-discussion-action"><span className="subtle">{t("已保存版本 v")}{task.version}</span>
              <button type="button" className="secondary" aria-describedby="task-native-help"
                disabled={nativeDisabled || saving} onClick={() => discuss(task)}>{nativePending ? t("正在追加…") : t("讨论此任务")}</button></div>
            <p className="form-note" id="task-native-help">{t("仅追加已保存的任务版本；未保存的修改不会带入对话。")} {nativeHelp}</p>
            {nativeFeedback && <p className={nativeFailed ? 'native-failure' : 'form-note'}
              role={nativeFailed ? 'alert' : 'status'}>{nativeFeedback}</p>}
          </div>}
          <label>{t("标题")}<input ref={first} name="title" required maxLength={500} defaultValue={task?.title} /></label>
          {task && <div className="form-columns">
            <label>{t("状态")}<select name="status" defaultValue={task.status}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <div className="field-info"><span>{t("执行者")}</span><span>{task.assignee ? name(task.assignee) : t("未认领")}</span></div>
          </div>}
          <label>{t("任务说明")}<textarea name="description" rows={3} maxLength={20000} defaultValue={task?.description} /></label>
          <label>{t("验收条件")}<textarea name="acceptanceCriteria" rows={3} maxLength={20000} defaultValue={task?.acceptanceCriteria} /></label>
          {task && <div className="field-info"><span>{t("资源")}</span><span>{related.length ? related.join(locale === 'en' ? ', ' : '、') : t("暂无活跃资源声明")}</span></div>}
        </> : <>
          <label>{t("资源名称")}<input ref={first} name="name" required maxLength={500} defaultValue={resource?.name} /></label>
          <label>{t("资源说明")}<textarea name="description" rows={3} maxLength={20000} defaultValue={resource?.description} /></label>
          <label>{t("使用约定")}<textarea name="accessNotes" rows={3} maxLength={20000} defaultValue={resource?.accessNotes} /></label>
          <p className="form-note">{t("说明访问和共享条件，请勿填写密码、密钥或订阅凭据。")}</p>
        </>}
        {error && <div className="error dialog-error" role="alert"><span>{error}</span>
          {conflict && <button type="button" disabled={saving} onClick={() => void reloadLatest()}>{t("载入最新内容")}</button>}</div>}
      </div>
      <div className="dialog-actions"><button type="button" className="secondary" onClick={close} disabled={saving}>{t("取消")}</button>
        <button type="submit" className="primary" disabled={saving || conflict}>{saving ? t("正在保存…") : item ? t("保存修改") : isTask ? t("创建任务") : t("添加资源")}</button></div>
    </form>
  </dialog>;
}

document.documentElement.lang = locale;
if (locale === 'en') document.title = 'Swarmboard · Workspace';
createRoot(document.getElementById('root')!).render(<Workspace />);
