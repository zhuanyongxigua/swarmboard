// Batch informational broadcasts without hiding evidence or changing who may collaborate.
import type { Entry } from './store.js';

export interface NotificationOptions { notificationBatchMs?: number; notificationMaxWaitMs?: number }
export interface NotificationSettings { quietMs: number; maxWaitMs: number }
export function notificationSettings(options: NotificationOptions, env: NodeJS.ProcessEnv = process.env): NotificationSettings {
  const read = (value: number | string | undefined, fallback: number, maximum: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (value === '' || !Number.isInteger(n) || n < 0 || n > maximum) throw new Error('Invalid notification batching configuration');
    return n;
  };
  const quietMs = read(options.notificationBatchMs ?? env.SWARMBOARD_NOTIFICATION_BATCH_MS, 15000, 60000);
  const maxWaitMs = read(options.notificationMaxWaitMs ?? env.SWARMBOARD_NOTIFICATION_MAX_WAIT_MS, 60000, 300000);
  if (maxWaitMs < quietMs) throw new Error('Notification maximum wait must cover the quiet window');
  return { quietMs, maxWaitMs };
}
export function notificationDelay(events: Entry[], settings: NotificationSettings, now: number, backlog = false): number {
  // OBSERVED includes human goal revisions, pool scope changes and host control.
  // Never defer those or directed requests and failures behind ordinary evidence.
  if (!events.length || !settings.quietMs || backlog || events.some(e => e.kind === 'OBSERVED' || e.kind === 'FAIL' || !!e.recipientId)) return 0;
  const times = events.map(e => Date.parse(e.createdAt));
  // A clock rollback or malformed legacy date must not strand the queue.
  if (times.some(t => !Number.isFinite(t) || t > now)) return 0;
  return Math.max(0, Math.min(Math.max(...times) + settings.quietMs, Math.min(...times) + settings.maxWaitMs) - now);
}
