// Render AI-selected notes and server-sourced facts separately; expired claims stay hidden locally.
import { useEffect, useState } from 'react';
import { locale, t } from './i18n.js';
import './collaboration-overview.css';

export interface OverviewFact {
  id: string; kind: 'count' | 'state' | 'model'; value: number | string | null;
  source: string; scope: string;
}
export interface OverviewSnapshot {
  status: 'missing' | 'current' | 'stale' | 'unavailable'; reason: string | null;
  record: null | { boardId: string; version: number; authorId: string; updatedAt: string; expiresAt: string;
    preferencesVersion: number; factsRevision: string;
    parts: ({ kind: 'text'; text: string } | { kind: 'fact'; factId: string })[] };
  facts: { revision: string; observedAt: string; available: boolean; items: OverviewFact[] };
}
const timestamp = (value: string) => new Date(value).toLocaleString(locale, { hour12: false });
function valueOf(fact: OverviewFact) {
  return fact.value === null ? t('未知') : typeof fact.value === 'number'
    ? new Intl.NumberFormat(locale).format(fact.value) : t(fact.value);
}

export function CollaborationOverview({ snapshot }: { snapshot: OverviewSnapshot | null }) {
  const [now, setNow] = useState(() => Date.now());
  const record = snapshot?.record;
  const expires = record ? Date.parse(record.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(expires - Date.now() + 1, 2147483647)));
    return () => clearTimeout(timer);
  }, [expires]);
  const expired = !Number.isFinite(expires) || expires <= Math.max(now, Date.now());
  const current = snapshot?.status === 'current' && snapshot.facts.available && !!record && !expired;
  const facts = new Map(snapshot?.facts.items.map(item => [item.id, item]));
  const referenced = record?.parts.flatMap(part => part.kind === 'fact' && facts.has(part.factId) ? [facts.get(part.factId)!] : []) ?? [];
  const unique = [...new Map(referenced.map(fact => [fact.id, fact])).values()];
  const state = !snapshot ? t('正在读取协作概览…')
    : snapshot.status === 'unavailable' || !snapshot.facts.available ? t('协作概览暂不可核实')
      : snapshot.status === 'stale' || record && expired ? t('概览已失效，请在正常工作回合中更新。')
        : t('尚无有效协作概览');

  return <section className="collaboration-overview" aria-label={t('协作概览')}>
    {current ? <div className="overview-parts">{record.parts.map((part, index) => part.kind === 'text'
      ? <span className="overview-note" key={index}><small>{t('AI 说明')}</small> {part.text}</span>
      : facts.has(part.factId)
        ? <span className="overview-fact" key={index} title={`${t('来源')}: ${facts.get(part.factId)!.source}`}>
          <span>{t(facts.get(part.factId)!.scope)}</span> <strong>{valueOf(facts.get(part.factId)!)}</strong>
        </span>
        : <span className="overview-unknown" key={index}>{t('引用已失效')} · {t('未知')}</span>)}</div>
      : <p className="overview-state">{state}</p>}
    {record ? <details className="overview-evidence">
      <summary>{t('概览依据')}</summary>
      <dl>
        <dt>{t('汇报来源')}</dt><dd>{record.authorId}</dd>
        <dt>{t('更新时间')}</dt><dd>{timestamp(record.updatedAt)}</dd>
        <dt>{t('有效至')}</dt><dd>{timestamp(record.expiresAt)}</dd>
        <dt>{t('采用的个人偏好版本')}</dt><dd>{record.preferencesVersion}</dd>
        {current && unique.map(fact => <div className="overview-source" key={fact.id}>
          <dt>{t(fact.scope)}</dt><dd>{fact.source} · {timestamp(snapshot.facts.observedAt)}</dd>
        </div>)}
      </dl>
      <p>{t('说明由成员选择和撰写；事实值来自可核实记录。未知不代表没有，登记不代表正在执行。')}</p>
    </details> : null}
  </section>;
}
