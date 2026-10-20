// Keep the AI-authored line compact; stale reports use only their own verified historical values.
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
    preferencesVersion: number; factsRevision: string; factSnapshot?: OverviewFact[];
    parts: ({ kind: 'text'; text: string } | { kind: 'fact'; factId: string })[] };
  facts: { revision: string; observedAt: string; available: boolean; items: OverviewFact[] };
}
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
  const facts = new Map((current ? snapshot.facts.items : record?.factSnapshot ?? []).map(item => [item.id, item]));
  const unavailable = snapshot?.status === 'unavailable';
  // No fixed text prefix: the state stays machine-readable and visually muted
  // so a stale/expired record is never presented as current.
  const viewState = current ? 'current' : expired ? 'expired' : snapshot?.status ?? 'missing';
  const freshness = current ? undefined : record ? t('协作概览已过期') : t('协作情况未知');

  return <section className="collaboration-overview" aria-label={t('协作概览')} aria-description={freshness} title={freshness} data-overview-state={viewState}>
    <p className="overview-line">{record?.parts.length ? <>
      {record.parts.map((part, index) => <span key={index}>{index ? ' ' : ''}{part.kind === 'text'
        ? part.text : <strong className="overview-fact">{facts.has(part.factId) ? valueOf(facts.get(part.factId)!) : t('未知')}</strong>}</span>)}
    </> : t('协作情况未知')}</p>
    {unavailable ? <p className="overview-error" role="alert">{t('协作概览暂不可核实')}</p> : null}
  </section>;
}
