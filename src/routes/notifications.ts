import { ObjectId } from 'mongodb';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  dismissNotification,
  listNotificationsForUser,
  markAllRead,
  markNotificationRead,
} from '../data/notifications.js';
import { authorizeChannel } from '../realtime/pusher.js';
import { getPool } from '../data/pools.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

export const notificationsRouter: Router = Router();
export const pusherRouter: Router = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/notifications
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  includeRead: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
});

notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { includeRead } = listQuerySchema.parse(req.query);
    const notifications = await listNotificationsForUser(req.user!.uid, { includeRead });
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

const parseObjectId = (raw: unknown): ObjectId | null => {
  if (typeof raw !== 'string' || !ObjectId.isValid(raw)) return null;
  return new ObjectId(raw);
};

notificationsRouter.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) {
      next(badRequest('Invalid id'));
      return;
    }
    const updated = await markNotificationRead(id, req.user!.uid);
    if (!updated) {
      next(notFound('Notification not found'));
      return;
    }
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/:id/dismiss', requireAuth, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) {
      next(badRequest('Invalid id'));
      return;
    }
    const updated = await dismissNotification(id, req.user!.uid);
    if (!updated) {
      next(notFound('Notification not found'));
      return;
    }
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    const count = await markAllRead(req.user!.uid);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/pusher/auth — private channel authorization (spec §7.6)
// ---------------------------------------------------------------------------

const pusherAuthSchema = z.object({
  socket_id: z.string().min(1),
  channel_name: z.string().min(1),
});

const PRIVATE_USER_PREFIX = 'private-user-';
const PRIVATE_POOL_PREFIX = 'private-pool-';

pusherRouter.post('/auth', requireAuth, async (req, res, next) => {
  try {
    const { socket_id: socketId, channel_name: channel } = pusherAuthSchema.parse(req.body ?? {});
    const me = req.user!;

    if (channel.startsWith(PRIVATE_USER_PREFIX)) {
      const targetUid = channel.slice(PRIVATE_USER_PREFIX.length);
      if (targetUid !== me.uid) {
        next(forbidden('Cannot subscribe to another user\'s channel'));
        return;
      }
    } else if (channel.startsWith(PRIVATE_POOL_PREFIX)) {
      const rawPoolId = channel.slice(PRIVATE_POOL_PREFIX.length);
      if (!ObjectId.isValid(rawPoolId)) {
        next(badRequest('Invalid pool id in channel name'));
        return;
      }
      const pool = await getPool(new ObjectId(rawPoolId));
      if (!pool || !pool.members[me.uid]) {
        next(forbidden('Not a member of this pool'));
        return;
      }
    } else {
      next(forbidden('Unsupported channel namespace'));
      return;
    }

    const auth = authorizeChannel(socketId, channel);
    if (!auth) {
      // Pusher not configured — return a clear error.
      next(badRequest('Realtime not configured on this server'));
      return;
    }
    res.json(auth);
  } catch (err) {
    next(err);
  }
});
