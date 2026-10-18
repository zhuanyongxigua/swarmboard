// Show reported progress separately from execution, with evidence available to pointer and keyboard users.
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { locale, t } from './i18n.js';
import './task-progress.css';

export interface TaskProgressSnapshot {
  percent: number | null;
  state: 'active' | 'waiting' | 'unknown';
  phase: string;
  verified: string;
  remaining: string;
  updatedAt: string | null;
  reportedBy: string | null;
}

export function TaskProgress({ progress, taskTitle }: { progress?: TaskProgressSnapshot | null; taskTitle: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const id = useId();
  const reliable = progress?.state !== 'unknown' && typeof progress?.percent === 'number'
    && Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100;
  const percent = reliable ? progress!.percent! : null;
  const state = reliable ? progress!.state : 'unknown';
  const stateLabel = state === 'waiting' ? t('等待中') : state === 'active' ? t('正常推进') : t('待评估');
  const phase = progress?.phase || t('尚无可靠估算');
  const timestamp = progress?.updatedAt && Number.isFinite(Date.parse(progress.updatedAt))
    ? new Date(progress.updatedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('未报告');

  function cancelHide() { clearTimeout(hideTimer.current); }
  function show() { cancelHide(); setOpen(true); }
  function hideAfterLeave() {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!pointerInside.current && document.activeElement !== trigger.current) setOpen(false);
    }, 120);
  }

  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!open) return;
    function positionTooltip() {
      const target = trigger.current?.getBoundingClientRect();
      const panel = tooltip.current?.getBoundingClientRect();
      if (!target || !panel) return;
      const left = Math.max(8, Math.min(target.left, window.innerWidth - panel.width - 8));
      const below = target.bottom + 8;
      const top = below + panel.height <= window.innerHeight - 8 ? below : Math.max(8, target.top - panel.height - 8);
      setPosition({ left, top });
    }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    positionTooltip();
    window.addEventListener('resize', positionTooltip);
    window.addEventListener('scroll', positionTooltip, true);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', positionTooltip);
      window.removeEventListener('scroll', positionTooltip, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, progress]);

  return <div className="task-progress" data-progress-state={state}>
    <button ref={trigger} type="button" className="task-progress-trigger"
      aria-label={`${taskTitle} · ${t('进度依据')} · ${percent === null ? t('待评估') : `${percent}%`} · ${stateLabel} · ${phase}`}
      aria-describedby={open ? id : undefined}
      onPointerEnter={() => { pointerInside.current = true; show(); }}
      onPointerLeave={() => { pointerInside.current = false; hideAfterLeave(); }}
      onFocus={show} onBlur={hideAfterLeave}
      onClick={event => { event.stopPropagation(); show(); }}
      onDragStart={event => event.preventDefault()}>
      <span className="task-progress-heading"><span>{t('完成进度')}</span>
        <span className={percent === null ? 'task-progress-unknown' : 'task-progress-percent'}>
          {percent === null ? t('待评估') : <>{percent}<small>%</small></>}
        </span>
      </span>
      <span className="task-progress-track" role="progressbar" aria-label={`${taskTitle} · ${t('完成进度')}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? t('待评估') : `${percent}% · ${stateLabel}`}>
        {percent !== null && <span className="task-progress-fill" style={{ width: `${percent}%` }} />}
      </span>
      <span className="task-progress-stage"><span title={phase}>{phase}</span><span>{stateLabel}</span></span>
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" className="task-progress-evidence"
      style={position}
      onPointerEnter={() => { pointerInside.current = true; cancelHide(); }}
      onPointerLeave={() => { pointerInside.current = false; hideAfterLeave(); }}>
      <strong>{t('进度依据')}</strong>
      <dl>
        <dt>{t('已验证成果')}</dt><dd>{progress?.verified || t('未报告')}</dd>
        <dt>{t('剩余事项')}</dt><dd>{progress?.remaining || t('未报告')}</dd>
        <dt>{t('更新时间')}</dt><dd>{timestamp}</dd>
        <dt>{t('汇报来源')}</dt><dd>{progress?.reportedBy || t('未报告')}</dd>
      </dl>
      <p>{t('成员汇报的估算，不表示模型正在执行或任务已验收。')}</p>
    </div>, document.body)}
  </div>;
}
