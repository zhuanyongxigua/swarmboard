import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

export type PreferenceSource = 'human-input' | 'main-chat-relay';
export type Preferences = {
  boardId: string; text: string; version: number;
  source: PreferenceSource | null; updatedAt: string | null;
};
export type PreferenceWrite = { text: string; expectedVersion: number; source: PreferenceSource };

function validate(value: Preferences): Preferences {
  if (!value || typeof value.boardId !== 'string' || typeof value.text !== 'string' || !Number.isInteger(value.version) || value.version < 0
    || ![null, 'human-input', 'main-chat-relay'].includes(value.source) || (value.updatedAt !== null && typeof value.updatedAt !== 'string')) {
    throw new Error(t('偏好响应无效，请重新读取。'));
  }
  return value;
}

export function PreferencesEditor({ read, write, refreshKey }: {
  read: () => Promise<Preferences>; write: (input: PreferenceWrite) => Promise<Preferences>; refreshKey: number;
}) {
  const [current, setCurrent] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<PreferenceSource>('human-input');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [conflictReady, setConflictReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const latest = useRef<Preferences | null>(null);
  const dirty = useRef(false);
  const mounted = useRef(true);
  const writing = useRef(false);
  const adopt = useCallback((value: Preferences, replaceDraft = false) => {
    if (!mounted.current || (latest.current?.boardId === value.boardId && latest.current.version > value.version)) return;
    const changed = latest.current && latest.current.version !== value.version;
    latest.current = value; setCurrent(value);
    if (!dirty.current || replaceDraft) {
      setDraft(value.text); setSource(value.source ?? 'human-input'); dirty.current = false; setConflict(false); setConflictReady(false);
    } else if (changed) { setConflict(true); setConflictReady(true); }
  }, []);
  const reload = useCallback(async (replaceDraft = false) => {
    try {
      const value = validate(await read());
      adopt(value, replaceDraft);
      if (mounted.current) setError('');
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t('无法读取个人偏好，请重试。'));
    } finally { if (mounted.current) setLoading(false); }
  }, [read, adopt]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { void reload(); }, [reload, refreshKey]);

  async function save(clear = false) {
    if (!latest.current || writing.current || conflict) return;
    dirty.current = true;
    writing.current = true; setSaving(true); setError(''); setNotice('');
    try {
      const value = validate(await write({ text: clear ? '' : draft, expectedVersion: latest.current.version, source }));
      adopt(value, true);
      if (mounted.current) setNotice(t(clear ? '个人偏好已清除。' : '个人偏好已保存。'));
    } catch (failure) {
      if (!mounted.current) return;
      const isConflict = (failure as { code?: string })?.code === 'VERSION_CONFLICT';
      setError(isConflict ? t('偏好已被更新，草稿已保留。请核对最新保存值。')
        : failure instanceof Error ? failure.message : t('个人偏好未保存，请重试。'));
      if (isConflict) {
        setConflict(true); setConflictReady(false);
        try { adopt(validate(await read())); } catch { /* Keep the draft and conflict fence until a later successful read. */ }
      }
    } finally { writing.current = false; if (mounted.current) setSaving(false); }
  }

  return <section className="preferences-panel" aria-labelledby="preferences-heading">
    <h2 id="preferences-heading">{t('个人偏好')}</h2>
    <p className="subtle">{t('偏好属于当前看板，不授予额外权限，也不覆盖任务约束。请勿填写密码或密钥。')}</p>
    {loading ? <p role="status">{t('正在读取个人偏好…')}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {current ? <>
      <div className="saved-preferences" aria-label={t('当前保存的偏好')}>
        <p className="subtle">{t('当前版本')} v{current.version} · {current.source === 'main-chat-relay' ? t('主聊天转达') : current.source === 'human-input' ? t('人类输入') : t('尚未设置')}
          {current.updatedAt ? <> · <time dateTime={current.updatedAt}>{new Date(current.updatedAt).toLocaleString()}</time></> : null}</p>
        <p className="preference-text">{current.text || t('尚无个人偏好。')}</p>
      </div>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label htmlFor="preference-text">{t('偏好内容')}</label>
        <textarea id="preference-text" rows={5} value={draft} disabled={saving} onChange={event => {
          dirty.current = true; setDraft(event.target.value); setNotice('');
        }} />
        <label htmlFor="preference-source">{t('内容来源')}</label>
        <select id="preference-source" value={source} disabled={saving} onChange={event => {
          dirty.current = true; setSource(event.target.value as PreferenceSource); setNotice('');
        }}>
          <option value="human-input">{t('人类输入')}</option>
          <option value="main-chat-relay">{t('主聊天转达')}</option>
        </select>
        {conflict ? <p role="status">{t('保存前请先核对当前版本；不会自动覆盖他人的修改。')}</p> : null}
        <div className="preference-actions">
          <button className="primary" type="submit" disabled={saving || conflict || !dirty.current}>{t(saving ? '正在保存…' : '保存偏好')}</button>
          <button className="secondary" type="button" disabled={saving || conflict || !current.text} onClick={() => void save(true)}>{t('清除已保存偏好')}</button>
          {conflict ? <button className="secondary" type="button" disabled={saving || !conflictReady} onClick={() => {
            setConflict(false); setError(''); setNotice(t('已采用当前版本，草稿仍保留。请检查后保存。'));
          }}>{t('按当前版本继续编辑')}</button> : null}
          <button className="secondary" type="button" disabled={saving} onClick={() => void reload(true)}>{t('放弃草稿并载入最新值')}</button>
        </div>
      </form>
    </> : !loading ? <button type="button" onClick={() => void reload()}>{t('重试')}</button> : null}
    <p role="status" aria-live="polite">{notice}</p>
  </section>;
}
