import React, { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

export type SettingsPool = { workspacePath?: string; taskIds?: string[]; size: number; minSize?: number; maxSize?: number; version: number };
export function SettingsDialog({ pool, saveCapacity, refresh, close, children }: {
  pool: SettingsPool | null; saveCapacity: (min: number, max: number, expectedVersion: number, onSaved?: () => void) => Promise<void>;
  refresh: () => Promise<void>; close: () => void; children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [min, setMin] = useState(String(pool?.minSize ?? 1));
  const [max, setMax] = useState(String(pool?.maxSize ?? ''));
  const [revision, setRevision] = useState(pool?.version);
  const [dirty, setDirty] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!pool || pool.version === revision) return;
    if (dirty) { setConflict(true); setError(t('成员配置已更新，草稿已保留。请重新读取并核对后保存。')); }
    else { setMin(String(pool.minSize ?? 1)); setMax(String(pool.maxSize)); setRevision(pool.version); }
  }, [pool, revision, dirty]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy.current || conflict || revision === undefined) return;
    const lower = Number(min), upper = Number(max);
    if (!min.trim() || !max.trim() || !Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower < 1 || upper > 128) {
      setError(t('成员上下限必须是 1 到 128 的整数。')); return;
    }
    if (lower > upper) { setError(t('最少成员不能大于最多成员。')); return; }
    busy.current = true; setSaving(true); setError(''); setNotice('');
    try { await saveCapacity(lower, upper, revision, () => { setDirty(false); setConflict(false); }); setDirty(false); setNotice(t('成员上下限已保存。人数调整将在安全边界完成。')); }
    catch (failure) {
      if ((failure as { saved?: boolean })?.saved) {
        // The POST already committed; a later runtime read failed. Keep the
        // saved value visible and show the refresh error separately.
        setDirty(false); setConflict(false); setNotice(t('成员上下限已保存。人数调整将在安全边界完成。'));
        setError(failure instanceof Error ? failure.message : t('成员上下限已保存，但最新状态读取失败，请重新读取核对。'));
      } else if ((failure as { code?: string })?.code === 'VERSION_CONFLICT') { setConflict(true); setError(t('成员配置已更新，草稿已保留。请重新读取并核对后保存。')); }
      else setError(failure instanceof Error ? failure.message : t('成员配置未保存，请重试。'));
    } finally { busy.current = false; setSaving(false); }
  }
  return <dialog ref={dialog} className="settings-dialog" aria-label={t('设置')} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-header"><h2 id="settings-heading">{t('设置')}</h2><button type="button" className="secondary" aria-label={t('关闭设置')} onClick={close}>×</button></div>
    <div className="settings-body">
      <button type="button" className="secondary" disabled={reloading} onClick={async () => { setReloading(true); try { await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : t('操作未完成，请重试。')); } finally { setReloading(false); } }}>{t('重新读取设置')}</button>
      <section aria-labelledby="capacity-heading"><h2 id="capacity-heading">{t('协作成员')}</h2>
        {pool?.workspacePath ? <form onSubmit={event => void save(event)} noValidate>
          <p className="subtle">{t('当前目标人数')} {pool.size} · {t('收缩会等待在途工作安全收尾，保留会话与历史。')}</p>
          <div className="capacity-fields">
            <label>{t('最少成员')}<input type="number" min="1" max="128" step="1" value={min} disabled={saving} onChange={event => { setMin(event.target.value); setDirty(true); setNotice(''); }} /></label>
            <label>{t('最多成员')}<input type="number" min="1" max="128" step="1" value={max} disabled={saving} onChange={event => { setMax(event.target.value); setDirty(true); setNotice(''); }} /></label>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <div className="preference-actions"><button type="submit" className="primary" disabled={saving || conflict || !dirty}>{saving ? t('正在保存…') : t('保存成员上下限')}</button>
            {conflict ? <button type="button" className="secondary" disabled={saving} onClick={() => { setMin(String(pool.minSize ?? 1)); setMax(String(pool.maxSize)); setRevision(pool.version); setDirty(false); setConflict(false); setError(''); }}>{t('放弃草稿并载入最新值')}</button> : null}</div>
          <p role="status">{notice}</p>
        </form> : <p className="subtle">{t('当前未配置协作组织，成员上下限暂不可编辑。')}</p>}
      </section>
      {children}
    </div>
  </dialog>;
}
