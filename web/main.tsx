import { SettingsDialog } from './settings-dialog.js';
import { locale, t } from './i18n.js';
import type { AutomationConfig } from '../src/automation.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import './style.css';
import { TaskProgress, type TaskProgressSnapshot } from './TaskProgress.js';
import { PreferencesEditor, type Preferences, type PreferenceWrite } from './preferences-editor.js';
import { CollaborationOverview, type OverviewSnapshot } from './CollaborationOverview.js';
import { boardTaskColumns, taskDropDestination } from './task-board-columns.js';
import { appendNativeDraft, nativeConversationUnavailableReason, startNativeAutomationSetup, taskDiscussionPrompt } from './native-conversation.js';

type Task = {
  id: string; title: string; description: string; acceptanceCriteria: string;
  status: string; assignee: string | null; participants?: string[]; version: number; updatedAt: string;
  progress?: TaskProgressSnapshot | null;
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
type Editor = { type: 'task'; item: Task } | { type: 'resource'; item?: Resource };
type UiOperation = 'board_read' | 'runtime_read' | 'overview_read' | 'automation_read'
  | 'pool_capacity' | 'pool_configure' | 'pool_control' | 'pool_reduce'
  | 'user_prompt_read' | 'user_prompt_write' | 'preferences_read' | 'preferences_write'
  | 'task_update' | 'resource_create' | 'resource_update';
type Tab = 'tasks' | 'shared';
type RuntimeStatus = { mode: 'events'; ciWatches?: { id: string; pipelineId: number; sha: string; state: string; error: string }[]; pool?: { id?: string; size: number; minSize?: number; maxSize?: number; workspacePath?: string; taskIds?: string[]; enabled: boolean; version: number; state: string; error: string } | null; activity?: { members: number; running: number; idle: number; draining?: number; state: string; executionMode: string; watchdog: { state: string; attempts: number; nextWakeAt: string | null } }; workers: { id: string; name: string; poolId?: string; enabled: boolean; status: string; error: string }[]; error: string };


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
async function operation<T>(name: UiOperation, args: Record<string, unknown> = {}): Promise<T> {
  if (bridge) return unpack(await bridge.callServerTool({ name, arguments: args })) as T;
  if (window.parent !== window) throw new OperationError(t("插件尚未连接桌面宿主，请重新打开面板后重试。"));
  let url = '/api/board';
  let method = 'GET';
  let body: Record<string, unknown> | undefined;
  const { id, ...patch } = args;
  if (name === 'runtime_read') url = '/api/runtime';
  if (name === 'pool_capacity') { url = '/api/pool/capacity'; method = 'POST'; body = args; }
  if (name === 'pool_configure') { url = '/api/pool/configure'; method = 'POST'; body = args; }
  if (name === 'pool_control') { url = '/api/pool/control'; method = 'POST'; body = args; }
  if (name === 'user_prompt_read') url = '/api/user-prompt';
  if (name === 'user_prompt_write') { url = '/api/user-prompt'; method = 'PATCH'; body = args; }
  if (name === 'preferences_read') url = '/api/preferences';
  if (name === 'overview_read') url = '/api/overview';
  if (name === 'preferences_write') { url = '/api/preferences'; method = 'PATCH'; body = args; }
  if (name === 'pool_reduce') { url = '/api/pool/reduce'; method = 'POST'; body = args; }
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
function readUserPrompt() { return operation<Preferences>('user_prompt_read'); }
function writeUserPrompt(input: PreferenceWrite) { return operation<Preferences>('user_prompt_write', input); }
function readPreferences() { return operation<Preferences>('preferences_read'); }
function writePreferences(input: PreferenceWrite) { return operation<Preferences>('preferences_write', input); }
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
function participants(task: Task) { return task.participants ?? (task.assignee ? [task.assignee] : []); }
function shortId(id: string) { return id.length > 12 ? `${id.slice(0, 8)}…` : id; }

function Workspace() {
  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState<Tab>('tasks');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [automation, setAutomation] = useState<AutomationConfig | null>(null);
  const [automationError, setAutomationError] = useState('');
  const [eventRuntime, setEventRuntime] = useState<RuntimeStatus | null>(null);
  const [overview, setOverview] = useState<OverviewSnapshot | null>(null);
  const overviewRead = useRef(0);
  const readRuntimeAndOverview = useCallback(async () => {
    const read = ++overviewRead.current;
    const current = await operation<RuntimeStatus>('runtime_read');
    if (mounted.current && read === overviewRead.current && current?.mode === 'events') setEventRuntime(current);
    try {
      const value = await operation<OverviewSnapshot>('overview_read');
      if (mounted.current && read === overviewRead.current) setOverview(value);
    } catch {
      if (mounted.current && read === overviewRead.current) setOverview({ status: 'unavailable', reason: 'read-failed', record: null,
        facts: { revision: '', observedAt: new Date().toISOString(), available: false, items: [] } });
    }
    return current;
  }, []);
  async function savePreferences(input: PreferenceWrite) {
    const value = await writePreferences(input);
    // A confirmed preference change invalidates prior presentation immediately;
    // an older in-flight overview read cannot restore it after this point.
    overviewRead.current++;
    setOverview(current => current?.record && current.record.preferencesVersion !== value.version
      ? { ...current, status: 'stale', reason: 'preferences-changed' } : current);
    void readRuntimeAndOverview().catch(() => {});
    return value;
  }
  const [poolBusy, setPoolBusy] = useState(false);
  const poolOperation = useRef(false);
  const [poolFeedback, setPoolFeedback] = useState('');
  const [poolError, setPoolError] = useState('');
  const memberLimit = eventRuntime?.pool?.maxSize ?? 8;
  const memberLimitReached = !!eventRuntime?.pool && eventRuntime.pool.size >= memberLimit;
  const memberLimitHint = t('已达成员上限（{limit} 人）').replace('{limit}', String(memberLimit));
  const minimumMembers = eventRuntime?.pool?.minSize ?? 1;
  const reduceDisabledReason = poolBusy ? t('正在更新成员，请稍候。')
    : eventRuntime?.pool && eventRuntime.pool.size <= minimumMembers
      ? t('至少保留 {limit} 名成员').replace('{limit}', String(minimumMembers))
      : !eventRuntime?.pool?.enabled ? t('协作已停止，暂不可调整成员。') : '';
  async function controlPool(enabled?: boolean) {
    const pool = eventRuntime?.pool; if (!pool || poolOperation.current) return;
    poolOperation.current = true; setPoolBusy(true); setPoolFeedback(''); setPoolError('');
    try { await operation('pool_control', { expectedVersion: pool.version, enabled: enabled ?? !pool.enabled }); await readRuntimeAndOverview(); }
    catch (error) { setError(message(error)); }
    finally { poolOperation.current = false; setPoolBusy(false); }
  }
  async function addPeer() {
    const pool = eventRuntime?.pool; if (!pool?.workspacePath || poolOperation.current) return;
    poolOperation.current = true; setPoolBusy(true); setPoolFeedback(''); setPoolError('');
    try { await operation('pool_configure', { workspacePath: pool.workspacePath, taskIds: pool.taskIds ?? [], size: pool.size + 1, maxSize: pool.maxSize, expectedVersion: pool.version }); await readRuntimeAndOverview(); }
    catch (error) { setError(message(error)); await readRuntimeAndOverview(); }
    finally { poolOperation.current = false; setPoolBusy(false); }
  }
  async function reducePeer() {
    const pool = eventRuntime?.pool;
    if (!pool?.workspacePath || poolOperation.current || reduceDisabledReason) return;
    poolOperation.current = true; setPoolBusy(true); setPoolFeedback(''); setPoolError('');
    try {
      await operation('pool_reduce', { expectedVersion: pool.version, requestId: crypto.randomUUID() });
      const current = await readRuntimeAndOverview();
      const before = eventRuntime?.activity?.members;
      setPoolFeedback(current.activity?.draining ? ''
        : before !== undefined && current.activity?.members === before - 1
          ? t('已减少一名成员。') : t('减少请求已接受，等待人数状态确认。'));
    } catch (error) {
      setPoolError(error instanceof OperationError ? message(error) : t('减少结果尚未确认，请刷新核对实际人数后再操作。'));
      // Reading after an error is safe; never replay an unconfirmed mutation.
      try { await readRuntimeAndOverview(); } catch { /* Preserve the last confirmed count. */ }
    } finally { poolOperation.current = false; setPoolBusy(false); }
  }
  const automationBusy = useRef(false);
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<Task | null>(null);
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
      if (mounted.current) { setAutomation(current => !current || config.version >= current.version ? config : current); setAutomationError(''); }
    } catch (error) {
      if (mounted.current) setAutomationError(message(error));
    }
  }, []);

  const ensureAutomation = useCallback(async (retry = false) => {
    const app = bridge;
    if (!app || automationBusy.current || nativeConversationUnavailableReason(app.getHostCapabilities(), app.getHostContext()?.platform)) return;
    automationBusy.current = true;
    let prepared: AutomationConfig | undefined;
    try {
      const result = unpack(await app.callServerTool({ name: 'automation_ensure', arguments: { retry } })) as {
        config: AutomationConfig; setupPrompt: string | null;
      };
      if (mounted.current) {
        setAutomation(current => !current || result.config.version >= current.version ? result.config : current);
        setAutomationError('');
      }
      if (result.setupPrompt) {
        prepared = result.config;
        await startNativeAutomationSetup(app, result.setupPrompt);
      }
    } catch (error) {
      const detail = message(error);
      if (mounted.current) setAutomationError(detail);
      if (prepared?.requestId) {
        try {
          const config = unpack(await app.callServerTool({ name: 'automation_setup_failed', arguments: {
            expectedVersion: prepared.version, requestId: prepared.requestId, error: detail,
          } })) as AutomationConfig;
          if (mounted.current) setAutomation(current => !current || config.version >= current.version ? config : current);
        } catch { await readAutomation(); }
      }
    } finally { automationBusy.current = false; }
  }, [readAutomation]);

  const refresh = useCallback(async (_quiet = false): Promise<Board | null> => {
    try {
      const data = await operation<Board>('board_read');
      void readAutomation();
      void readRuntimeAndOverview().catch(() => { if (mounted.current) setOverview({ status: 'unavailable', reason: 'runtime-unavailable', record: null,
        facts: { revision: '', observedAt: new Date().toISOString(), available: false, items: [] } }); });
      if (mounted.current) {
        setBoard(data); setError('');
      }
      return data;
    } catch (error) {
      if (mounted.current) setError(message(error));
      return null;
    } finally {
      if (mounted.current) { setLoading(false); }
    }
  }, [readAutomation, readRuntimeAndOverview]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let localBridge: App | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function start() {
      try {
        if (window.parent !== window) {
          const app = new App({ name: 'Swarmboard', version: '0.7.2' });
          localBridge = app;
          app.ontoolresult = result => {
            try {
              const data = unpack(result) as Board;
              if (data?.tasks && data?.resources && active) {
                setBoard(data); setLoading(false);
              }
            } catch (error) { if (active) setError(message(error)); }
          };
          app.onhostcontextchanged = () => {
            if (active) setNativeUnavailable(nativeConversationUnavailableReason(app.getHostCapabilities(), app.getHostContext()?.platform));
          };
          await app.connect();
          if (!active) return;
          bridge = app;

          setNativeUnavailable(nativeConversationUnavailableReason(app.getHostCapabilities(), app.getHostContext()?.platform));
        }
        await refresh();
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh(true);
        }, 15000);
        if (active) await ensureAutomation();
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
  }, [refresh, ensureAutomation]);

  const name = (id: string) => id === 'human' ? t("空间管理者") : board?.agents.find(agent => agent.id === id)?.name ?? id;
  const stale = (id: string) => {
    const agent = board?.agents.find(agent => agent.id === id);
    return Boolean(agent && Date.now() - Date.parse(agent.lastSeenAt) > 120000);
  };
  const usages = board?.usages.filter(usage => usage.active) ?? [];
  const autoUnavailable = Boolean(automation?.desiredEnabled && nativeUnavailable);
  const autoError = automationError || (automation?.state === 'error' ? automation.lastError : '');
  async function refreshSettings() { const cursor = board?.cursor; const latest = await refresh(); await ensureAutomation(true); await readRuntimeAndOverview(); if (!latest || latest.cursor === cursor) setSettingsRefresh(value => value + 1); }
  async function saveCapacity(minSize: number, maxSize: number, expectedVersion: number, onSaved?: () => void) {
    const pool = eventRuntime?.pool;
    if (!pool?.workspacePath || poolOperation.current) throw new Error(t('正在更新成员，请稍候。'));
    poolOperation.current = true; setPoolBusy(true);
    try {
      await operation('pool_capacity', { minSize, maxSize, expectedVersion });
      // The POST is authoritative: adopt its version before the refresh so the
      // SettingsDialog draft effect cannot mistake our own confirmed revision
      // for a concurrent edit and raise a false conflict.
      onSaved?.();
      try { await readRuntimeAndOverview(); }
      catch (failure) {
        const detail = failure instanceof Error && failure.message ? ' ' + failure.message : '';
        const error = new Error(t('成员上下限已保存，但最新状态读取失败，请重新读取核对。') + detail);
        (error as { saved?: boolean }).saved = true;
        throw error;
      }
    } catch (failure) {
      if (!(failure as { saved?: boolean })?.saved) await readRuntimeAndOverview().catch(() => {});
      throw failure;
    }
    finally { poolOperation.current = false; setPoolBusy(false); }
  }


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
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    changeTab(tabs[next].id);
    document.getElementById(`tab-${tabs[next].id}`)?.focus();
  }
  function openTask(taskId: string) {
    const task = board?.tasks.find(task => task.id === taskId);
    if (task) { setTab('tasks'); setEditor({ type: 'task', item: task }); }
  }
  function openResource(resourceId: string) {
    if (!board?.resources.some(resource => resource.id === resourceId)) return;
    setSettingsOpen(true); setExpandedResource(resourceId);
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
    const destination = taskDropDestination(task.status, status);
    if (destination === 'choose') setPendingMove(task);
    else if (destination) void moveTask(task, destination);
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

  return <div className="workspace" data-panel={tab}>
    <header className="workspace-header">
      <h1>Swarmboard</h1>
      <nav className="tabs" role="tablist" aria-label={t("工作面板")}>
        {tabs.map((item, index) => <button key={item.id} type="button" role="tab"
          id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`}
          tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => tabKey(event, index)}
          onClick={() => changeTab(item.id)}>{item.title}</button>)}
      </nav>
      <button className="settings-button" type="button" aria-label={t('设置')} onClick={() => setSettingsOpen(true)}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </header>
    {eventRuntime ? <div className="automation-notice" role="status">
      {eventRuntime.pool ? <div className="pool-controls"><CollaborationOverview snapshot={overview} />
        {eventRuntime.pool.workspacePath ? <span className="add-peer-control" tabIndex={memberLimitReached ? 0 : undefined}>
          <button type="button" className="secondary" disabled={poolBusy || !eventRuntime.pool.enabled || memberLimitReached} aria-describedby={memberLimitReached ? 'member-limit-tooltip' : undefined} onClick={() => void addPeer()}>{t('增加成员')}</button>
          {memberLimitReached ? <span id="member-limit-tooltip" className="member-limit-tooltip" role="tooltip">{memberLimitHint}</span> : null}
        </span> : null}
        {eventRuntime.pool.workspacePath ? <span className="add-peer-control" tabIndex={reduceDisabledReason ? 0 : undefined}>
          <button type="button" className="secondary" disabled={Boolean(reduceDisabledReason)} aria-describedby={reduceDisabledReason ? 'member-minimum-tooltip' : undefined} onClick={() => void reducePeer()}>{t('减少成员')}</button>
          {reduceDisabledReason ? <span id="member-minimum-tooltip" className="member-limit-tooltip" role="tooltip">{reduceDisabledReason}</span> : null}
        </span> : null}
      </div>
        : <CollaborationOverview snapshot={overview} />}
      {eventRuntime.activity?.draining ? <p className="subtle">{eventRuntime.activity.draining} {t('个正在退出')} · {t('正在等待成员安全收尾或核清，实际人数尚未减少。')}</p> : poolFeedback ? <p className="subtle">{poolFeedback}</p> : null}
      {poolError ? <p role="alert">{poolError}</p> : null}
      {eventRuntime.ciWatches?.some(w => w.state === 'watching') ? <p className="subtle">{t('等待 CI 结果，完成后通知全体成员')}</p> : null}
      {eventRuntime.ciWatches?.filter(w => w.state === 'error').map(w => <p role="alert" key={w.id}>CI #{w.pipelineId}: {w.error}</p>)}
      {eventRuntime.activity?.watchdog.nextWakeAt ? <p className="subtle">{t('下次空闲检查')} {time(eventRuntime.activity.watchdog.nextWakeAt, true)}</p> : null}
      {eventRuntime.pool?.enabled && eventRuntime.activity?.watchdog.state === 'attention' ? <p role="alert">{t('两次空闲检查后目标仍未推进，请检查阻塞原因。')}{' '}<button type="button" className="secondary" disabled={poolBusy} onClick={() => void controlPool(true)}>{t('重新检查')}</button></p> : null}
      {eventRuntime.pool?.error ? <p role="alert">{eventRuntime.pool.error}</p> : null}
      {eventRuntime.workers.filter(w => w.error).map(w => <p role="alert" key={w.id}>{w.name}: {w.error}</p>)}
      {eventRuntime.error ? <p role="alert">{eventRuntime.error}</p> : null}
    </div> : autoUnavailable ? <p className="automation-notice" role="status">{t("当前宿主不支持自动认领，任务与资源仍可使用。")}</p>
      : autoError ? <p className="automation-notice" role="alert">{t("自动认领初始化未完成：")}{autoError}</p>
        : automation?.state === 'pending' ? <p className="automation-notice" role="status">{automation.setupMode === 'reconcile'
          ? t("正在核对自动认领状态。") : t("正在初始化自动认领，等待宿主确认。")}</p> : null}
    <main id={`panel-${tab}`} className={tab === 'tasks' ? 'task-panel' : undefined} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'shared' && <div className="panel-toolbar">
        <span className="subtle">{t("Agent 交互记录")}</span>
        <span className="subtle">{t("只读")}</span>
      </div>}
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
             : <SharedFeed board={board} name={name} openTask={openTask} openResource={openResource} />}
    </main>
    {settingsOpen && <SettingsDialog pool={eventRuntime?.pool ?? null} saveCapacity={saveCapacity} refresh={refreshSettings} close={() => setSettingsOpen(false)}>
      <PreferencesEditor read={readPreferences} write={savePreferences} refreshKey={settingsRefresh + (board?.cursor ?? 0)} kind="system" />
      <PreferencesEditor read={readUserPrompt} write={writeUserPrompt} refreshKey={settingsRefresh + (board?.cursor ?? 0)} kind="user" />
      <details className="legacy-resources" open={expandedResource !== null}><summary>{t('原资源记录')}</summary>
        <p className="subtle">{t('原资源与使用声明原样保留，只读查看；不会自动转为用户提示词。')}</p>
        {board ? <ResourcePool board={board} usages={usages} name={name} stale={stale} expanded={expandedResource}
          toggle={id => setExpandedResource(current => current === id ? null : id)} /> : null}
      </details>
    </SettingsDialog>}
    <div className="sr-only" aria-live="polite">{announcement}</div>
    {pendingMove && <PendingMoveDialog task={pendingMove} close={() => setPendingMove(null)}
      choose={status => { setPendingMove(null); void moveTask(pendingMove, status); }} />}
    {editor && <EditorDialog key={`${editor.type}-${editor.type === 'task' ? editor.item.id : editor.item?.id ?? 'new-resource'}-${editor.item?.version ?? 0}`}
      editor={editor} name={name} usages={usages} resources={board?.resources ?? []}
      close={() => setEditor(null)} saved={() => { setEditor(null); setAnnouncement(t("修改已保存。")); void refresh(true); }}
      failed={() => refresh(true)} reload={reloadEditor}
      nativeDisabled={nativeDisabled} nativeHelp={nativeHelp} nativePending={nativePending}
      nativeFeedback={nativeFeedbackTaskId === editor.item?.id ? nativeFeedback : ''}
      nativeFailed={nativeFailed} discuss={task => void discuss(task)} />}
  </div>;
}

function TaskBoard({ board, usages, name, stale, movingId, open, dragStart, dragEnd, dragOver, drop }: {
  board: Board; usages: Usage[]; name: (id: string) => string; stale: (id: string) => boolean;
  movingId: string | null; open: (task: Task) => void;
  dragStart: (event: React.DragEvent, task: Task) => void; dragEnd: () => void;
  dragOver: (event: React.DragEvent) => void; drop: (event: React.DragEvent, status: string) => void;
}) {
  const columns = boardTaskColumns(board.tasks);
  return <div className="task-board" role="region" tabIndex={0} aria-label={t("任务状态看板")} style={{ '--column-count': columns.length } as React.CSSProperties}>
    {columns.map(({ id: status, tasks }) => {
      const label = status === 'pending' ? t('待处理') : statuses[status];
      return <section className="task-column" key={status} aria-label={label}
        data-status={status} onDragOver={dragOver} onDrop={event => drop(event, status)}>
        <div className="column-heading"><h2>{label}</h2><span>{tasks.length}</span></div>
        <div className="column-list" data-drop-status={status}>
          {tasks.length ? tasks.map(task => {
            const related = [...new Set(usages.filter(usage => usage.taskId === task.id).map(usage => usage.resourceId))]
              .map(id => board.resources.find(resource => resource.id === id)?.name ?? id);
            return <div key={task.id} className="task-card" draggable={movingId === null}
              data-card-id={task.id} aria-busy={movingId === task.id}
              onDragStart={event => dragStart(event, task)} onDragEnd={dragEnd}>
              <button type="button" className="task-open" data-task-id={task.id}
                aria-label={`${t('查看任务')} ${task.title}`} aria-describedby={status === 'pending' ? `task-state-${task.id}` : undefined}
                disabled={movingId === task.id} onClick={() => open(task)}>
                <span className="task-title" title={task.title}>{task.title}</span>
                {status === 'pending' && <span id={`task-state-${task.id}`} className="task-state" data-task-state={task.status}>
                  <span className="task-state-dot" aria-hidden="true" />{statuses[task.status]}
                </span>}
                {task.status !== 'in_progress' && task.description && <span className="task-excerpt">{task.description.replace(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/gi, shortId)}</span>}
              </button>
              {task.status === 'in_progress' && <TaskProgress taskTitle={task.title} progress={task.progress} />}
              <span className="task-footer">
                <span title={participants(task).map(name).join(', ')}>{participants(task).length ? `${t('参与者')} ${participants(task).length}` : t("未认领")}
                  {participants(task).length > 0 && participants(task).every(stale) && <span className="stale"> {t("· 最近未报告")}</span>}</span>
                <time dateTime={task.updatedAt} title={time(task.updatedAt, true)}>{time(task.updatedAt)}</time>
              </span>
              {related.length > 0 && <span className="task-related" title={related.join(locale === 'en' ? ', ' : '、')}>{related.join(locale === 'en' ? ', ' : '、')}</span>}
            </div>;
          }) : <p className="column-empty">{t("暂无任务")}</p>}
        </div>
      </section>;
    })}
  </div>;
}

function PendingMoveDialog({ task, close, choose }: {
  task: Task; close: () => void; choose: (status: 'in_review' | 'blocked') => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="pending-move-title" aria-describedby="pending-move-description"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === dialog.current) close(); }}>
    <div className="dialog-header"><h2 id="pending-move-title">{t('选择待处理状态')}</h2></div>
    <div className="pending-move-description" id="pending-move-description">{task.title} — {t('请选择待验收或受阻，取消不会修改任务。')}</div>
    <div className="dialog-actions">
      <button type="button" className="secondary" onClick={close} autoFocus>{t('取消')}</button>
      <button type="button" onClick={() => choose('in_review')}>{t('待验收')}</button>
      <button type="button" onClick={() => choose('blocked')}>{t('受阻')}</button>
    </div>
  </dialog>;
}

function ResourcePool({ board, usages, name, stale, expanded, toggle }: {
  board: Board; usages: Usage[]; name: (id: string) => string; stale: (id: string) => boolean;
  expanded: string | null; toggle: (id: string) => void;
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
            <span className="subtle">{t("只读")}</span></div>
          <p className="subtle">ID: {resource.id} · v{resource.version} · <span>{resource.kind}</span> · {resource.capabilities.join(', ')}</p>
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
  const title = isTask ? t("任务详情") : item ? t("编辑资源") : t("添加资源");
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
    setSaving(true); setError('');
    try {
      if (editor.type === 'task') {
        await operation('task_update', { id: editor.item.id, expectedVersion: editor.item.version,
          title: value('title'), description: value('description'), acceptanceCriteria: value('acceptanceCriteria'), status: value('status') });
      } else {
        const args: Record<string, unknown> = { name: value('name'), description: value('description'), accessNotes: value('accessNotes') };
        if (editor.item) { args.id = editor.item.id; args.expectedVersion = editor.item.version; }
        await operation(editor.item ? 'resource_update' : 'resource_create', args);
      }
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
          {task && <label>{t("任务 ID")}<input readOnly value={task.id} /></label>}
          <label>{t("标题")}<input ref={first} name="title" required maxLength={500} defaultValue={task?.title} /></label>
          {task && <div className="form-columns">
            <label>{t("状态")}<select name="status" defaultValue={task.status}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <div className="field-info"><span>{t("参与者")}</span><span>{participants(task).map(name).join(', ') || t("未认领")}</span></div>
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
        <button type="submit" className="primary" disabled={saving || conflict}>{saving ? t("正在保存…") : isTask || item ? t("保存修改") : t("添加资源")}</button></div>
    </form>
  </dialog>;
}

document.documentElement.lang = locale;
if (locale === 'en') document.title = 'Swarmboard · Workspace';
createRoot(document.getElementById('root')!).render(<Workspace />);
