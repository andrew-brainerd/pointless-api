import { ObjectId } from 'mongodb';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { addMember, getPool } from '../data/pools.js';
import { getInvite, listPendingInvitesForUid, markInviteStatus, tieInviteToUid } from '../data/invites.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';

export const invitesRouter: Router = Router();

invitesRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const invites = await listPendingInvitesForUid(req.user!.uid);
    res.json({ invites });
  } catch (err) {
    next(err);
  }
});

const loadInviteForUser = async (
  rawId: string | undefined,
  uid: string,
  email: string,
): Promise<
  | { ok: true; invite: Awaited<ReturnType<typeof getInvite>> & object }
  | { ok: false; error: ReturnType<typeof badRequest> }
> => {
  if (!rawId || !ObjectId.isValid(rawId)) {
    return { ok: false, error: badRequest('Invalid inviteId') };
  }
  const invite = await getInvite(new ObjectId(rawId));
  if (!invite) return { ok: false, error: notFound('Invite not found') };
  const matchesUid = invite.invitedUid === uid;
  const matchesEmail = !invite.invitedUid && invite.invitedEmail === email.toLowerCase();
  if (!matchesUid && !matchesEmail) {
    return { ok: false, error: forbidden('This invite is not yours') };
  }
  if (invite.status !== 'pending') {
    return { ok: false, error: conflict(`Invite is already ${invite.status}`) };
  }
  return { ok: true, invite };
};

invitesRouter.post('/:inviteId/accept', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const raw = req.params.inviteId;
    const loaded = await loadInviteForUser(typeof raw === 'string' ? raw : undefined, user.uid, user.email);
    if (!loaded.ok) {
      next(loaded.error);
      return;
    }
    const { invite } = loaded;
    const pool = await getPool(invite.poolId);
    if (!pool) {
      // Pool was deleted out from under the invite — clean up + 404.
      await markInviteStatus(invite._id, 'revoked');
      next(notFound('Pool no longer exists'));
      return;
    }
    if (invite.invitedUid !== user.uid) {
      await tieInviteToUid(invite._id, user.uid);
    }
    if (!pool.members[user.uid]) {
      await addMember({ poolId: pool._id, uid: user.uid, role: 'member' });
    }
    const updatedInvite = await markInviteStatus(invite._id, 'accepted');
    const updatedPool = await getPool(pool._id);
    res.json({ invite: updatedInvite, pool: updatedPool });
  } catch (err) {
    next(err);
  }
});

invitesRouter.post('/:inviteId/decline', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const raw = req.params.inviteId;
    const loaded = await loadInviteForUser(typeof raw === 'string' ? raw : undefined, user.uid, user.email);
    if (!loaded.ok) {
      next(loaded.error);
      return;
    }
    if (loaded.invite.invitedUid !== user.uid) {
      await tieInviteToUid(loaded.invite._id, user.uid);
    }
    const updated = await markInviteStatus(loaded.invite._id, 'declined');
    res.json({ invite: updated });
  } catch (err) {
    next(err);
  }
});
