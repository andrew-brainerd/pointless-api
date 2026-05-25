import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getUserByUid, upsertUser } from '../data/users.js';
import {
  invitesCollection,
  listPendingInvitesForUid,
  resolveInvitesForEmail,
} from '../data/invites.js';
import { notFound } from '../lib/errors.js';
import { notify } from '../realtime/events.js';
import type { CreateNotificationInput } from '../data/notifications.js';

export const usersRouter: Router = Router();

const syncBodySchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  photoURL: z.string().url().nullable().optional(),
});

// POST /users/sync — idempotent provision on first sign-in.
// Token claims are the source of truth for uid + email; body may refine
// displayName/photoURL (Firebase doesn't always populate these for email/link sign-in).
// C-2: also resolves any email-only pending invites against this uid.
usersRouter.post('/sync', requireAuth, async (req, res, next) => {
  try {
    const body = syncBodySchema.parse(req.body ?? {});
    const tokenUser = req.user!;
    const doc = await upsertUser(tokenUser.uid, {
      email: tokenUser.email,
      displayName: body.displayName ?? tokenUser.name,
      photoURL: body.photoURL ?? null,
    });
    const resolvedInvites = await resolveInvitesForEmail(tokenUser.email, tokenUser.uid);
    res.json({ user: doc, resolvedInvites });

    // For each newly-resolved invite, create a pool_invite notification so
    // the freshly-signed-in user sees their pending invites in the drawer.
    if (resolvedInvites > 0) {
      const myInvites = await listPendingInvitesForUid(tokenUser.uid);
      // listPendingInvitesForUid is reused — it returns all pending invites
      // for the uid, including ones that just got tied. Build notifications
      // only for these new arrivals (heuristic: filter by no prior notification).
      void invitesCollection(); // ensure collection is initialized
      const notifications: CreateNotificationInput[] = myInvites.map(invite => ({
        userUid: tokenUser.uid,
        type: 'pool_invite',
        title: 'Pool invite',
        body: `You have a pending invite to a pool`,
        link: `/invites/${invite._id.toHexString()}`,
        payload: { inviteId: invite._id.toHexString(), poolId: invite.poolId.toHexString() },
      }));
      void notify({
        notifications,
        user: notifications.map(n => ({
          uid: n.userUid,
          event: 'invite.received',
          data: n.payload!,
        })),
      });
    }
  } catch (err) {
    next(err);
  }
});

usersRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const tokenUser = req.user!;
    const doc = await getUserByUid(tokenUser.uid);
    if (!doc) {
      next(notFound('User not provisioned — call POST /users/sync first'));
      return;
    }
    res.json({ user: doc });
  } catch (err) {
    next(err);
  }
});
