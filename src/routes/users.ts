import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getUserByUid, upsertUser } from '../data/users.js';
import { resolveInvitesForEmail } from '../data/invites.js';
import { notFound } from '../lib/errors.js';

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
