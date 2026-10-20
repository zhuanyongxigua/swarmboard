// Member-facing notification API: the only supported way for a registered
// external adapter to publish its channel declaration, read its own pending
// delivery intents and record receipts.
//
// Identity and scope are enforced here, never taken from the payload: a caller
// may only declare *itself*, only for tasks it is already admitted to, and may
// only read or acknowledge its own deliveries. Adapters therefore never touch
// the board database and never load code from task text.
import type { Store } from './store.js';
import type { CollaboratorStore } from './collaborators.js';
import { AppError } from './store.js';
import type { NotificationAdapterRegistration } from './notification-adapters.js';
import { NotificationAdapterStore } from './notification-adapter-store.js';

export interface NotificationPendingItem {
  adapterId: string;
  memberId: string;
  sequence: number;
  entryIds: number[];
  state: 'pending' | 'unknown';
  reason?: string;
}

export interface NotificationPendingPage {
  items: NotificationPendingItem[];
  /** Highest sequence inspected; pass back as `after` on the next read. */
  cursor: number;
  hasMore: boolean;
}

export class NotificationService {
  private readonly adapters: NotificationAdapterStore;

  constructor(private readonly board: Store, private readonly collaborators?: CollaboratorStore) {
    this.adapters = new NotificationAdapterStore(board.db);
  }

  private admitted(collaboratorId: string) {
    const record = this.collaborators?.get(collaboratorId);
    if (!record || !record.enabled || record.revokedAt) {
      throw new AppError('COLLABORATOR_NOT_ADMITTED', 'A current admitted collaborator identity is required for notification tools', 403);
    }
    return record;
  }

  /**
   * Register or replace the caller's own channel. The declaration must describe
   * exactly this collaborator and only tasks it is currently admitted to, so a
   * member cannot widen its own scope by registering itself.
   */
  register(collaboratorId: string, declaration: {
    id: string; version: number; displayName: string; harness: string; enabled: boolean;
    capabilities: readonly string[];
    members: { memberId: string; sessionRef: string; taskIds: readonly string[]; boardWide?: boolean }[];
  }): NotificationAdapterRegistration {
    const record = this.admitted(collaboratorId);
    if (declaration.members.length !== 1 || declaration.members[0]?.memberId !== collaboratorId) {
      throw new AppError('BOUND_IDENTITY', 'A notification declaration may only describe the calling collaborator', 403);
    }
    if (declaration.members[0].sessionRef !== record.sessionRef) {
      throw new AppError('BOUND_IDENTITY', 'Notification session reference must match the admitted session', 403);
    }
    const outside = declaration.members[0].taskIds.filter(id => !record.taskIds.includes(id));
    if (outside.length) {
      throw new AppError('SCOPE_VIOLATION', `Notification scope exceeds admitted tasks: ${outside.join(', ')}`, 403);
    }
    // The durable store re-validates and enforces the version guard, which is
    // what stops a stale declaration from replacing a newer scope.
    return this.adapters.save({ ...declaration, members: [...declaration.members] } as unknown as NotificationAdapterRegistration);
  }

  /** Incremental read of the caller's own unsettled deliveries. */
  pending(collaboratorId: string, after = 0, limit = 50): NotificationPendingPage {
    this.admitted(collaboratorId);
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError('VALIDATION_ERROR', 'Invalid cursor', 400);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError('VALIDATION_ERROR', 'Invalid limit', 400);
    const mine = this.adapters.unsettled()
      .filter(item => item.intent.memberId === collaboratorId && item.intent.sequence > after)
      .sort((a, b) => a.intent.sequence - b.intent.sequence);
    const page = mine.slice(0, limit);
    return {
      items: page.map(item => ({
        adapterId: item.intent.adapterId,
        memberId: item.intent.memberId,
        sequence: item.intent.sequence,
        entryIds: [...item.intent.entryIds],
        state: item.state.state as 'pending' | 'unknown',
        ...(item.state.state === 'unknown' ? { reason: item.state.reason } : {}),
      })),
      cursor: page.length ? page[page.length - 1]!.intent.sequence : after,
      hasMore: mine.length > page.length,
    };
  }

  /** Confirm consumption of one of the caller's own deliveries. */
  receipt(collaboratorId: string, sequence: number, consumed: boolean): { sequence: number; consumed: boolean } {
    this.admitted(collaboratorId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new AppError('VALIDATION_ERROR', 'Invalid delivery sequence', 400);
    if (typeof consumed !== 'boolean') throw new AppError('VALIDATION_ERROR', 'consumed must be a boolean', 400);
    const mine = this.adapters.unsettled().find(item => item.intent.memberId === collaboratorId && item.intent.sequence === sequence);
    if (!mine) throw new AppError('DELIVERY_NOT_FOUND', 'No unsettled delivery with that sequence for this collaborator', 404);
    this.adapters.recordReceipt(mine.intent.adapterId, collaboratorId, { sequence, consumed });
    return { sequence, consumed };
  }
}
