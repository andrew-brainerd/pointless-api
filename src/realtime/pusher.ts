import Pusher from 'pusher';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

let cached: Pusher | undefined;
let attempted = false;

// Lazy init. When PUSHER_* env vars are missing, getPusher() returns
// undefined and trigger() silently no-ops — so `pnpm dev:local` works
// without a Pusher account.
export const getPusher = (): Pusher | undefined => {
  if (cached) return cached;
  if (attempted) return undefined;
  attempted = true;
  const env = loadEnv();
  if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET || !env.PUSHER_CLUSTER) {
    logger.warn('Pusher env not set — realtime events disabled');
    return undefined;
  }
  cached = new Pusher({
    appId: env.PUSHER_APP_ID,
    key: env.PUSHER_KEY,
    secret: env.PUSHER_SECRET,
    cluster: env.PUSHER_CLUSTER,
    useTLS: true,
  });
  return cached;
};

// ---------------------------------------------------------------------------
// Channel + event names (spec §7.6)
// ---------------------------------------------------------------------------

export const poolChannel = (poolId: string): string => `private-pool-${poolId}`;
export const userChannel = (uid: string): string => `private-user-${uid}`;

export type PoolEvent =
  | 'wager.created'
  | 'wager.staked'
  | 'wager.resolution.proposed'
  | 'wager.settled'
  | 'wager.disputed'
  | 'wager.voided'
  | 'member.joined'
  | 'member.left';

export type UserEvent = 'notification.created' | 'invite.received' | 'invite.resolved';

// ---------------------------------------------------------------------------
// trigger() — fire-and-forget. Logs but never throws on failure so a Pusher
// outage doesn't break the API write that just succeeded.
// ---------------------------------------------------------------------------

export const trigger = async (
  channel: string,
  event: PoolEvent | UserEvent,
  data: object,
): Promise<void> => {
  const p = getPusher();
  if (!p) return;
  try {
    await p.trigger(channel, event, data);
  } catch (err) {
    logger.error({ err, channel, event }, 'pusher trigger failed');
  }
};

export const triggerBatch = async (
  items: Array<{ channel: string; event: PoolEvent | UserEvent; data: object }>,
): Promise<void> => {
  const p = getPusher();
  if (!p || items.length === 0) return;
  try {
    await p.triggerBatch(items.map(i => ({ channel: i.channel, name: i.event, data: i.data })));
  } catch (err) {
    logger.error({ err, count: items.length }, 'pusher trigger batch failed');
  }
};

// Used by /pusher/auth endpoint.
export const authorizeChannel = (
  socketId: string,
  channel: string,
): { auth: string } | null => {
  const p = getPusher();
  if (!p) return null;
  return p.authorizeChannel(socketId, channel);
};
