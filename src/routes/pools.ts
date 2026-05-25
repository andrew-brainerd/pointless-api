import { ObjectId } from 'mongodb';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePoolAdmin, requirePoolMember } from '../auth/poolAuthz.js';
import {
  adminCount,
  changeRole,
  createPool,
  deletePool,
  listPoolsForUser,
  longestTenuredMember,
  removeMember,
  updatePoolConfig,
  type MemberRole,
  type PoolDoc,
} from '../data/pools.js';
import {
  createInvite,
  getInvite,
  listInvitesForPool,
  markInviteStatus,
} from '../data/invites.js';
import { getUserByEmail, getUserByUid } from '../data/users.js';
import { sendInviteEmail } from '../email/sendgrid.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export const poolsRouter: Router = Router();

const nameSchema = z.string().trim().min(1).max(80);
const startingPointsSchema = z.number().int().positive().max(1_000_000);

const createBodySchema = z.object({
  name: nameSchema,
  startingPoints: startingPointsSchema.default(500),
});

poolsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createBodySchema.parse(req.body ?? {});
    const user = req.user!;
    const pool = await createPool({
      name: body.name,
      createdBy: user.uid,
      startingPoints: body.startingPoints,
    });
    res.status(201).json({ pool });
  } catch (err) {
    next(err);
  }
});

poolsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const pools = await listPoolsForUser(req.user!.uid);
    res.json({ pools });
  } catch (err) {
    next(err);
  }
});

poolsRouter.get('/:poolId', requireAuth, requirePoolMember, (req, res) => {
  res.json({ pool: req.pool });
});

const patchBodySchema = z.object({
  name: nameSchema.optional(),
  startingPoints: startingPointsSchema.optional(),
});

poolsRouter.patch('/:poolId', requireAuth, requirePoolMember, requirePoolAdmin, async (req, res, next) => {
  try {
    const body = patchBodySchema.parse(req.body ?? {});
    if (body.name === undefined && body.startingPoints === undefined) {
      next(badRequest('Provide at least one of: name, startingPoints'));
      return;
    }
    const patch: { name?: string; startingPoints?: number } = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.startingPoints !== undefined) patch.startingPoints = body.startingPoints;
    const updated = await updatePoolConfig(req.pool!._id, patch);
    res.json({ pool: updated });
  } catch (err) {
    next(err);
  }
});

poolsRouter.delete(
  '/:poolId',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      // Wager guard (FR-08 / spec §7.5) — once wagers land in Phase D, refuse
      // delete when active/disputed wagers exist. For now there are no wagers.
      await deletePool(req.pool!._id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

const inviteBodySchema = z
  .object({
    invitedUid: z.string().min(1).optional(),
    invitedEmail: z.string().email().optional(),
  })
  .refine(b => b.invitedUid || b.invitedEmail, {
    message: 'invitedUid or invitedEmail required',
  });

poolsRouter.post(
  '/:poolId/invites',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      const body = inviteBodySchema.parse(req.body ?? {});
      const pool = req.pool!;
      const inviter = req.user!;

      let invitedUid: string | null = null;
      let invitedEmail: string;

      if (body.invitedUid) {
        invitedUid = body.invitedUid;
        const inviteeDoc = await getUserByUid(invitedUid);
        if (!inviteeDoc) {
          next(notFound('User not found'));
          return;
        }
        if (pool.members[invitedUid]) {
          res.status(200).json({ status: 'already_member' });
          return;
        }
        invitedEmail = inviteeDoc.email;
      } else {
        invitedEmail = body.invitedEmail!.toLowerCase();
        // If a user already exists at that email, attach the uid now.
        const existing = await getUserByEmail(invitedEmail);
        if (existing) {
          invitedUid = existing._id;
          if (pool.members[existing._id]) {
            res.status(200).json({ status: 'already_member' });
            return;
          }
        }
      }

      const { invite, created } = await createInvite({
        poolId: pool._id,
        invitedUid,
        invitedEmail,
        invitedBy: inviter.uid,
      });

      // Send email if the invitee isn't yet a user (no uid resolved).
      if (created && !invitedUid) {
        const env = loadEnv();
        try {
          await sendInviteEmail({
            toEmail: invitedEmail,
            inviterName: inviter.name,
            poolName: pool.name,
            inviteUrl: `${env.FRONTEND_URL}/invites/${invite._id.toHexString()}`,
          });
        } catch (err) {
          logger.error({ err, inviteId: invite._id.toHexString() }, 'sendInviteEmail failed');
        }
      }

      res.status(created ? 201 : 200).json({
        invite,
        status: created ? 'created' : 'already_invited',
      });
    } catch (err) {
      next(err);
    }
  },
);

poolsRouter.get(
  '/:poolId/invites',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      const invites = await listInvitesForPool(req.pool!._id);
      res.json({ invites });
    } catch (err) {
      next(err);
    }
  },
);

poolsRouter.delete(
  '/:poolId/invites/:inviteId',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      const raw = req.params.inviteId;
      if (typeof raw !== 'string' || !ObjectId.isValid(raw)) {
        next(badRequest('Invalid inviteId'));
        return;
      }
      const invite = await getInvite(new ObjectId(raw));
      if (!invite || !invite.poolId.equals(req.pool!._id)) {
        next(notFound('Invite not found'));
        return;
      }
      if (invite.status !== 'pending') {
        next(conflict(`Cannot revoke invite in status "${invite.status}"`));
        return;
      }
      const updated = await markInviteStatus(invite._id, 'revoked');
      res.json({ invite: updated });
    } catch (err) {
      next(err);
    }
  },
);

poolsRouter.post('/:poolId/leave', requireAuth, requirePoolMember, async (req, res, next) => {
  try {
    const uid = req.user!.uid;
    const pool = req.pool!;
    const isLastAdmin =
      pool.members[uid]?.role === 'admin' &&
      adminCount(pool) === 1 &&
      Object.keys(pool.members).length > 1;
    if (isLastAdmin) {
      next(
        conflict(
          'You are the last admin — promote another member to admin or delete the pool first',
        ),
      );
      return;
    }
    const updated = await removeMember(pool._id, uid);
    await maybeAutoCleanup(updated);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

poolsRouter.delete(
  '/:poolId/members/:uid',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      const targetUid = typeof req.params.uid === 'string' ? req.params.uid : undefined;
      const pool = req.pool!;
      if (!targetUid || !pool.members[targetUid]) {
        next(notFound('Member not in pool'));
        return;
      }
      if (targetUid === req.user!.uid) {
        next(badRequest('Use POST /pools/:poolId/leave to remove yourself'));
        return;
      }
      const target = pool.members[targetUid];
      if (target.role === 'admin' && adminCount(pool) === 1) {
        next(conflict('Cannot remove the last admin'));
        return;
      }
      const updated = await removeMember(pool._id, targetUid);
      await maybeAutoCleanup(updated);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

const rolePatchSchema = z.object({ role: z.enum(['admin', 'member']) });

poolsRouter.patch(
  '/:poolId/members/:uid/role',
  requireAuth,
  requirePoolMember,
  requirePoolAdmin,
  async (req, res, next) => {
    try {
      const targetUid = typeof req.params.uid === 'string' ? req.params.uid : undefined;
      const pool = req.pool!;
      const { role } = rolePatchSchema.parse(req.body ?? {});
      if (!targetUid || !pool.members[targetUid]) {
        next(notFound('Member not in pool'));
        return;
      }
      const target = pool.members[targetUid];
      if (target.role === role) {
        res.json({ pool });
        return;
      }
      if (target.role === 'admin' && role === 'member' && adminCount(pool) === 1) {
        next(conflict('Cannot demote the last admin'));
        return;
      }
      const updated = await changeRole(pool._id, targetUid, role satisfies MemberRole);
      res.json({ pool: updated });
    } catch (err) {
      next(err);
    }
  },
);

// AC-05.4: pool with zero members is auto-deleted; pool with zero admins
// auto-promotes the longest-tenured member to admin.
const maybeAutoCleanup = async (pool: PoolDoc | null): Promise<void> => {
  if (!pool) return;
  if (Object.keys(pool.members).length === 0) {
    await deletePool(pool._id);
    return;
  }
  if (adminCount(pool) === 0) {
    const nextAdmin = longestTenuredMember(pool);
    if (nextAdmin) {
      await changeRole(pool._id, nextAdmin, 'admin');
    }
  }
};
