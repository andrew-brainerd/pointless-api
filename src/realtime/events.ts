import { createNotifications, type CreateNotificationInput } from '../data/notifications.js';
import { logger } from '../lib/logger.js';
import {
  poolChannel,
  triggerBatch,
  userChannel,
  type PoolEvent,
  type UserEvent,
} from './pusher.js';

// Helper for state-change handlers: create notification rows + fire Pusher events.
// All firing happens after the response is sent (fire-and-forget). Failures
// are logged but never propagate to the route handler.

export interface PoolFanout {
  poolId: string;
  event: PoolEvent;
  data: Record<string, unknown>;
}

export interface UserFanout {
  uid: string;
  event: UserEvent;
  data: Record<string, unknown>;
}

export interface NotifyOptions {
  notifications?: CreateNotificationInput[];
  pool?: PoolFanout;
  user?: UserFanout | UserFanout[];
}

// Always fire-and-forget — failures are logged but never propagate (so a
// background notify() doesn't crash the process / unhandled-rejection a test).
export const notify = async (opts: NotifyOptions): Promise<void> => {
  try {
    const created = await createNotifications(opts.notifications ?? []);

    const items: Array<{ channel: string; event: PoolEvent | UserEvent; data: object }> = [];

    if (opts.pool) {
      items.push({
        channel: poolChannel(opts.pool.poolId),
        event: opts.pool.event,
        data: opts.pool.data,
      });
    }

    const userEvents = Array.isArray(opts.user) ? opts.user : opts.user ? [opts.user] : [];
    for (const u of userEvents) {
      items.push({ channel: userChannel(u.uid), event: u.event, data: u.data });
    }

    for (const n of created) {
      items.push({
        channel: userChannel(n.userUid),
        event: 'notification.created',
        data: { notificationId: n._id.toHexString(), type: n.type },
      });
    }

    await triggerBatch(items);
  } catch (err) {
    logger.error({ err }, 'notify() failed');
  }
};
