import type { ClientSession, ObjectId } from 'mongodb';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireWagerPoolAdmin, requireWagerVisible } from '../auth/wagerAuthz.js';
import { poolsCollection, type PoolDoc } from '../data/pools.js';
import {
  buildWagerDoc,
  computePayout,
  computeStatusAfterStake,
  wagersCollection,
  type WagerDoc,
  type WagerParticipant,
} from '../data/wagers.js';
import { withTransaction } from '../db/mongo.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { notify } from '../realtime/events.js';
import type { CreateNotificationInput } from '../data/notifications.js';

export const wagersRouter: Router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(64);
const labelSchema = z.string().trim().min(1).max(80);
const stakeSchema = z.number().int().positive().max(1_000_000);

const createBodySchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    options: z
      .array(z.object({ id: idSchema, label: labelSchema }))
      .min(2)
      .max(10)
      .superRefine((opts, ctx) => {
        const ids = new Set(opts.map(o => o.id));
        if (ids.size !== opts.length) {
          ctx.addIssue({ code: 'custom', message: 'options[].id must be unique' });
        }
      }),
    closeBy: z.string().datetime().nullable().optional(),
    invitedUids: z.array(z.string().min(1)).optional(),
    myOptionId: idSchema,
    myStake: stakeSchema,
  })
  .superRefine((body, ctx) => {
    if (!body.options.some(o => o.id === body.myOptionId)) {
      ctx.addIssue({ code: 'custom', path: ['myOptionId'], message: 'myOptionId must match an option' });
    }
  });

const stakeBodySchema = z.object({ optionId: idSchema, stake: stakeSchema });
const proposeBodySchema = z.object({ optionId: idSchema });
const adminResolveBodySchema = z.union([
  z.object({ optionId: idSchema, void: z.literal(false).optional() }),
  z.object({ void: z.literal(true) }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const availableBalance = (pool: PoolDoc, uid: string): number => {
  const m = pool.members[uid];
  return m ? m.balance - m.pending : 0;
};

const isStaked = (wager: WagerDoc, uid: string): WagerParticipant | undefined =>
  wager.participants.find(p => p.uid === uid);

const optionExists = (wager: WagerDoc, optionId: string): boolean =>
  wager.options.some(o => o.id === optionId);

const poolAdminUids = (pool: PoolDoc): string[] =>
  Object.entries(pool.members)
    .filter(([, m]) => m.role === 'admin')
    .map(([uid]) => uid);

const allStakedUids = (wager: WagerDoc): string[] =>
  wager.participants.map(p => p.uid);

const wagerLink = (wagerId: string): string => `/wagers/${wagerId}`;

// Apply a payout result to the pool: each participant's balance += credit and
// pending -= their stake. Used by settle + void code paths.
const applyPayoutInTx = async (
  session: ClientSession,
  wager: WagerDoc,
  payouts: Record<string, number>,
): Promise<void> => {
  const pools = await poolsCollection();
  const inc: Record<string, number> = {};
  for (const p of wager.participants) {
    const credit = payouts[p.uid] ?? 0;
    inc[`members.${p.uid}.balance`] = (inc[`members.${p.uid}.balance`] ?? 0) + credit;
    inc[`members.${p.uid}.pending`] = (inc[`members.${p.uid}.pending`] ?? 0) - p.stake;
  }
  await pools.updateOne({ _id: wager.poolId }, { $inc: inc }, { session });
};

// ---------------------------------------------------------------------------
// POST /api/v1/pools/:poolId/wagers — create
// (mounted on poolsRouter via the helper below)
// ---------------------------------------------------------------------------

export const createWagerHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = createBodySchema.parse(req.body ?? {});
    const pool = req.pool!;
    const me = req.user!.uid;

    // Resolve invited participants: default is everyone in the pool except creator.
    const allMemberUids = pool.memberUids.filter(u => u !== me);
    const invited = body.invitedUids
      ? body.invitedUids.filter(u => u !== me && pool.members[u])
      : allMemberUids;

    if (body.invitedUids) {
      const unknown = body.invitedUids.filter(u => u !== me && !pool.members[u]);
      if (unknown.length > 0) {
        next(badRequest(`invitedUids includes non-members: ${unknown.join(', ')}`));
        return;
      }
    }

    const available = availableBalance(pool, me);
    if (body.myStake > available) {
      next(badRequest(`Stake (${body.myStake}) exceeds available balance (${available})`));
      return;
    }

    const wagerDoc = buildWagerDoc({
      poolId: pool._id,
      createdBy: me,
      description: body.description,
      options: body.options,
      closeBy: body.closeBy ? new Date(body.closeBy) : null,
      invitedUids: invited,
      creatorStake: { optionId: body.myOptionId, amount: body.myStake },
    });

    await withTransaction(async session => {
      const wagers = await wagersCollection();
      const pools = await poolsCollection();
      await wagers.insertOne(wagerDoc, { session });
      await pools.updateOne(
        { _id: pool._id },
        {
          $inc: {
            [`members.${me}.balance`]: -body.myStake,
            [`members.${me}.pending`]: body.myStake,
          },
        },
        { session },
      );
    });

    res.status(201).json({ wager: wagerDoc });

    const wagerId = wagerDoc._id.toHexString();
    const inviteNotifs: CreateNotificationInput[] = invited.map(uid => ({
      userUid: uid,
      type: 'wager_invite',
      title: "You're invited to a wager",
      body: `${req.user!.name} created: ${body.description}`,
      link: wagerLink(wagerId),
      payload: { wagerId, poolId: pool._id.toHexString() },
    }));
    void notify({
      notifications: inviteNotifs,
      pool: {
        poolId: pool._id.toHexString(),
        event: 'wager.created',
        data: { wagerId, createdBy: me },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/pools/:poolId/wagers — list (mounted on poolsRouter)
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z
    .enum(['proposed', 'active', 'pending_confirmation', 'disputed', 'settled', 'voided'])
    .optional(),
});

export const listWagersHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = listQuerySchema.parse(req.query);
    const wagers = await wagersCollection();
    const filter: Record<string, unknown> = { poolId: req.pool!._id };
    if (q.status) filter.status = q.status;
    const docs = await wagers.find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ wagers: docs });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// /api/v1/wagers/* routes
// ---------------------------------------------------------------------------

wagersRouter.get('/:wagerId', requireAuth, requireWagerVisible, (req, res) => {
  res.json({ wager: req.wager });
});

wagersRouter.post('/:wagerId/stake', requireAuth, requireWagerVisible, async (req, res, next) => {
  try {
    const { optionId, stake } = stakeBodySchema.parse(req.body ?? {});
    const wager = req.wager!;
    const pool = req.pool!;
    const me = req.user!.uid;

    if (wager.status !== 'proposed' && wager.status !== 'active') {
      next(conflict(`Cannot stake on a wager in status "${wager.status}"`));
      return;
    }
    if (isStaked(wager, me)) {
      next(conflict('You have already staked on this wager'));
      return;
    }
    if (wager.declinedUids.includes(me)) {
      next(conflict('You have already declined this wager'));
      return;
    }
    if (!wager.invitedUids.includes(me) && wager.createdBy !== me) {
      next(forbidden('You were not invited to this wager'));
      return;
    }
    if (!optionExists(wager, optionId)) {
      next(badRequest('optionId does not match any option on this wager'));
      return;
    }
    const available = availableBalance(pool, me);
    if (stake > available) {
      next(badRequest(`Stake (${stake}) exceeds available balance (${available})`));
      return;
    }

    const now = new Date();
    const newParticipant: WagerParticipant = {
      uid: me,
      optionId,
      stake,
      stakedAt: now,
    };
    const projectedStatus = computeStatusAfterStake({
      ...wager,
      participants: [...wager.participants, newParticipant],
    });

    let updated: WagerDoc | null = null;
    await withTransaction(async session => {
      const wagers = await wagersCollection();
      const pools = await poolsCollection();
      updated = await wagers.findOneAndUpdate(
        { _id: wager._id, status: { $in: ['proposed', 'active'] } },
        {
          $push: { participants: newParticipant },
          $pull: { invitedUids: me },
          $set: { status: projectedStatus },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw conflict('Wager state changed concurrently — retry');
      await pools.updateOne(
        { _id: pool._id },
        {
          $inc: {
            [`members.${me}.balance`]: -stake,
            [`members.${me}.pending`]: stake,
          },
        },
        { session },
      );
    });

    res.json({ wager: updated });

    void notify({
      pool: {
        poolId: pool._id.toHexString(),
        event: 'wager.staked',
        data: { wagerId: wager._id.toHexString(), uid: me },
      },
    });
  } catch (err) {
    next(err);
  }
});

wagersRouter.post('/:wagerId/decline', requireAuth, requireWagerVisible, async (req, res, next) => {
  try {
    const wager = req.wager!;
    const me = req.user!.uid;

    if (wager.status === 'settled' || wager.status === 'voided') {
      next(conflict(`Cannot decline a wager in status "${wager.status}"`));
      return;
    }
    if (isStaked(wager, me)) {
      next(conflict('You have already staked on this wager — cannot decline'));
      return;
    }
    if (wager.declinedUids.includes(me)) {
      next(conflict('You have already declined this wager'));
      return;
    }
    if (!wager.invitedUids.includes(me)) {
      next(forbidden('You were not invited to this wager'));
      return;
    }

    const wagers = await wagersCollection();
    const updated = await wagers.findOneAndUpdate(
      { _id: wager._id },
      { $addToSet: { declinedUids: me }, $pull: { invitedUids: me } },
      { returnDocument: 'after' },
    );
    res.json({ wager: updated });
  } catch (err) {
    next(err);
  }
});

wagersRouter.post('/:wagerId/cancel', requireAuth, requireWagerVisible, async (req, res, next) => {
  try {
    const wager = req.wager!;
    const me = req.user!.uid;

    if (wager.createdBy !== me) {
      next(forbidden('Only the wager creator can cancel'));
      return;
    }
    if (wager.status !== 'proposed') {
      next(conflict(`Cannot cancel a wager in status "${wager.status}"`));
      return;
    }

    // Refund every (currently only the creator) stake.
    const refund: Record<string, number> = {};
    for (const p of wager.participants) refund[p.uid] = p.stake;

    let updated: WagerDoc | null = null;
    await withTransaction(async session => {
      const wagers = await wagersCollection();
      await applyPayoutInTx(session, wager, refund);
      updated = await wagers.findOneAndUpdate(
        { _id: wager._id, status: 'proposed' },
        {
          $set: { status: 'voided', voidedAt: new Date(), voidReason: 'cancelled' },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw conflict('Wager state changed concurrently — retry');
    });
    res.json({ wager: updated });

    void notify({
      pool: {
        poolId: wager.poolId.toHexString(),
        event: 'wager.voided',
        data: { wagerId: wager._id.toHexString(), reason: 'cancelled' },
      },
    });
  } catch (err) {
    next(err);
  }
});

wagersRouter.post(
  '/:wagerId/propose-resolution',
  requireAuth,
  requireWagerVisible,
  async (req, res, next) => {
    try {
      const { optionId } = proposeBodySchema.parse(req.body ?? {});
      const wager = req.wager!;
      const me = req.user!.uid;

      if (wager.status !== 'active') {
        next(conflict(`Cannot propose resolution while wager is "${wager.status}"`));
        return;
      }
      if (!isStaked(wager, me)) {
        next(forbidden('Only staked participants can propose a resolution'));
        return;
      }
      if (!optionExists(wager, optionId)) {
        next(badRequest('optionId does not match any option on this wager'));
        return;
      }

      const wagers = await wagersCollection();
      const updated = await wagers.findOneAndUpdate(
        { _id: wager._id, status: 'active' },
        {
          $set: {
            status: 'pending_confirmation',
            resolution: {
              proposedBy: me,
              proposedAt: new Date(),
              optionId,
              confirmations: [],
              disputes: [],
            },
          },
        },
        { returnDocument: 'after' },
      );
      if (!updated) {
        next(conflict('Wager state changed concurrently — retry'));
        return;
      }
      res.json({ wager: updated });

      const wagerId = wager._id.toHexString();
      const proposedOption = wager.options.find(o => o.id === optionId);
      const recipients = stakedOthers(wager, me);
      void notify({
        notifications: recipients.map(uid => ({
          userUid: uid,
          type: 'wager_resolution_proposed',
          title: 'Resolution proposed',
          body: `${req.user!.name} proposed "${proposedOption?.label ?? optionId}" as the winner`,
          link: wagerLink(wagerId),
          payload: { wagerId, optionId },
        })),
        pool: {
          poolId: wager.poolId.toHexString(),
          event: 'wager.resolution.proposed',
          data: { wagerId, proposedBy: me, optionId },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

const stakedOthers = (wager: WagerDoc, proposerUid: string): string[] =>
  wager.participants.filter(p => p.uid !== proposerUid).map(p => p.uid);

wagersRouter.post(
  '/:wagerId/confirm-resolution',
  requireAuth,
  requireWagerVisible,
  async (req, res, next) => {
    try {
      const wager = req.wager!;
      const me = req.user!.uid;
      const resolution = wager.resolution;

      if (wager.status !== 'pending_confirmation' || !resolution) {
        next(conflict(`Wager is not pending confirmation (status "${wager.status}")`));
        return;
      }
      if (!isStaked(wager, me)) {
        next(forbidden('Only staked participants can confirm'));
        return;
      }
      if (me === resolution.proposedBy) {
        next(badRequest('Proposer cannot also confirm'));
        return;
      }
      if (resolution.confirmations.includes(me)) {
        next(conflict('Already confirmed'));
        return;
      }

      const newConfirmations = [...resolution.confirmations, me];
      const others = stakedOthers(wager, resolution.proposedBy);
      const everyoneConfirmed = others.every(u => newConfirmations.includes(u));

      if (!everyoneConfirmed) {
        const wagers = await wagersCollection();
        const updated = await wagers.findOneAndUpdate(
          { _id: wager._id, status: 'pending_confirmation' },
          { $addToSet: { 'resolution.confirmations': me } },
          { returnDocument: 'after' },
        );
        res.json({ wager: updated });
        return;
      }

      // All non-proposer participants have confirmed → settle.
      let updated: WagerDoc | null = null;
      await withTransaction(async session => {
        const wagers = await wagersCollection();
        const result = computePayout(wager.participants, resolution.optionId);
        await applyPayoutInTx(session, wager, result.payouts);
        updated = await wagers.findOneAndUpdate(
          { _id: wager._id, status: 'pending_confirmation' },
          {
            $addToSet: { 'resolution.confirmations': me },
            $set: result.voided
              ? {
                  status: 'voided',
                  voidedAt: new Date(),
                  voidReason: 'all_one_option',
                }
              : {
                  status: 'settled',
                  settledAt: new Date(),
                  settledOptionId: resolution.optionId,
                },
          },
          { session, returnDocument: 'after' },
        );
        if (!updated) throw conflict('Wager state changed concurrently — retry');
      });
      res.json({ wager: updated });

      const settled = updated!;
      const wagerId = wager._id.toHexString();
      const winningOption = wager.options.find(o => o.id === resolution.optionId);
      const recipients = allStakedUids(wager);
      const isVoid = settled.status === 'voided';
      void notify({
        notifications: recipients.map(uid => ({
          userUid: uid,
          type: isVoid ? 'wager_voided' : 'wager_settled',
          title: isVoid ? 'Wager voided' : 'Wager settled',
          body: isVoid
            ? `${wager.description} — no losers, refunded.`
            : `Winner: ${winningOption?.label ?? resolution.optionId}`,
          link: wagerLink(wagerId),
          payload: { wagerId, optionId: resolution.optionId },
        })),
        pool: {
          poolId: wager.poolId.toHexString(),
          event: isVoid ? 'wager.voided' : 'wager.settled',
          data: { wagerId, settledOptionId: isVoid ? null : resolution.optionId },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

wagersRouter.post(
  '/:wagerId/dispute-resolution',
  requireAuth,
  requireWagerVisible,
  async (req, res, next) => {
    try {
      const wager = req.wager!;
      const me = req.user!.uid;
      const resolution = wager.resolution;

      if (wager.status !== 'pending_confirmation' || !resolution) {
        next(conflict(`Wager is not pending confirmation (status "${wager.status}")`));
        return;
      }
      if (!isStaked(wager, me)) {
        next(forbidden('Only staked participants can dispute'));
        return;
      }
      if (me === resolution.proposedBy) {
        next(badRequest('Proposer cannot also dispute'));
        return;
      }

      const wagers = await wagersCollection();
      const updated = await wagers.findOneAndUpdate(
        { _id: wager._id, status: 'pending_confirmation' },
        {
          $addToSet: { 'resolution.disputes': me },
          $set: { status: 'disputed' },
        },
        { returnDocument: 'after' },
      );
      if (!updated) {
        next(conflict('Wager state changed concurrently — retry'));
        return;
      }
      res.json({ wager: updated });

      const pool = req.pool!;
      const wagerId = wager._id.toHexString();
      const admins = poolAdminUids(pool);
      void notify({
        notifications: admins.map(uid => ({
          userUid: uid,
          type: 'wager_disputed',
          title: 'Wager disputed',
          body: `${req.user!.name} disputed the proposed resolution`,
          link: wagerLink(wagerId),
          payload: { wagerId },
        })),
        pool: {
          poolId: wager.poolId.toHexString(),
          event: 'wager.disputed',
          data: { wagerId, disputedBy: me },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// D-3 / FR-08: leave-mid-wager handler. Called from routes/pools.ts BEFORE
// the pool member is removed. For each unsettled wager the leaver staked in:
//   - status 'proposed' OR (remaining participants < 2 after removal) -> void
//     and refund remaining participants (leaver's stake is forfeit).
//   - otherwise -> remove the leaver from participants + resolution arrays
//     and let the wager continue with a reduced pot.
// ---------------------------------------------------------------------------
export const handleLeaverWagers = async (
  poolId: ObjectId,
  leaverUid: string,
): Promise<void> => {
  const wagers = await wagersCollection();
  const open = await wagers
    .find({
      poolId,
      'participants.uid': leaverUid,
      status: { $in: ['proposed', 'active', 'pending_confirmation', 'disputed'] },
    })
    .toArray();

  for (const wager of open) {
    await withTransaction(async session => {
      const remaining = wager.participants.filter(p => p.uid !== leaverUid);
      const shouldVoid = wager.status === 'proposed' || remaining.length < 2;
      const w = await wagersCollection();
      const pools = await poolsCollection();

      if (shouldVoid) {
        if (remaining.length > 0) {
          const inc: Record<string, number> = {};
          for (const p of remaining) {
            inc[`members.${p.uid}.balance`] = (inc[`members.${p.uid}.balance`] ?? 0) + p.stake;
            inc[`members.${p.uid}.pending`] = (inc[`members.${p.uid}.pending`] ?? 0) - p.stake;
          }
          await pools.updateOne({ _id: poolId }, { $inc: inc }, { session });
        }
        await w.updateOne(
          { _id: wager._id },
          {
            $set: {
              status: 'voided',
              voidedAt: new Date(),
              voidReason: 'last_member_left',
            },
          },
          { session },
        );
      } else {
        // $pull on 'resolution.confirmations' errors in Mongo if resolution
        // is null (can't traverse a null path), so apply that part conditionally.
        const pull: Record<string, unknown> = {
          participants: { uid: leaverUid },
          invitedUids: leaverUid,
        };
        if (wager.resolution) {
          pull['resolution.confirmations'] = leaverUid;
          pull['resolution.disputes'] = leaverUid;
        }
        await w.updateOne({ _id: wager._id }, { $pull: pull }, { session });
      }
    });
  }
};

wagersRouter.post(
  '/:wagerId/admin-resolve',
  requireAuth,
  requireWagerVisible,
  requireWagerPoolAdmin,
  async (req, res, next) => {
    try {
      const body = adminResolveBodySchema.parse(req.body ?? {});
      const wager = req.wager!;

      if (wager.status !== 'disputed') {
        next(conflict(`Admin resolve only valid for disputed wagers (status "${wager.status}")`));
        return;
      }

      let updated: WagerDoc | null = null;
      await withTransaction(async session => {
        const wagers = await wagersCollection();
        const now = new Date();
        if ('void' in body && body.void) {
          // Refund all stakes.
          const refund: Record<string, number> = {};
          for (const p of wager.participants) refund[p.uid] = p.stake;
          await applyPayoutInTx(session, wager, refund);
          updated = await wagers.findOneAndUpdate(
            { _id: wager._id, status: 'disputed' },
            { $set: { status: 'voided', voidedAt: now, voidReason: 'admin_void' } },
            { session, returnDocument: 'after' },
          );
        } else {
          const optionId = (body as { optionId: string }).optionId;
          if (!optionExists(wager, optionId)) {
            throw badRequest('optionId does not match any option on this wager');
          }
          const result = computePayout(wager.participants, optionId);
          await applyPayoutInTx(session, wager, result.payouts);
          updated = await wagers.findOneAndUpdate(
            { _id: wager._id, status: 'disputed' },
            {
              $set: result.voided
                ? { status: 'voided', voidedAt: now, voidReason: 'admin_void' }
                : { status: 'settled', settledAt: now, settledOptionId: optionId },
            },
            { session, returnDocument: 'after' },
          );
        }
        if (!updated) throw conflict('Wager state changed concurrently — retry');
      });

      res.json({ wager: updated });

      const settled = updated!;
      const wagerId = wager._id.toHexString();
      const isVoid = settled.status === 'voided';
      const settledOption = settled.settledOptionId
        ? wager.options.find(o => o.id === settled.settledOptionId)
        : undefined;
      const recipients = allStakedUids(wager);
      void notify({
        notifications: recipients.map(uid => ({
          userUid: uid,
          type: isVoid ? 'wager_voided' : 'wager_settled',
          title: isVoid ? 'Wager voided (admin)' : 'Wager settled (admin)',
          body: isVoid
            ? `${wager.description} — admin voided. All stakes refunded.`
            : `Winner: ${settledOption?.label ?? settled.settledOptionId ?? '?'}`,
          link: wagerLink(wagerId),
          payload: { wagerId, settledOptionId: settled.settledOptionId },
        })),
        pool: {
          poolId: wager.poolId.toHexString(),
          event: isVoid ? 'wager.voided' : 'wager.settled',
          data: { wagerId, settledOptionId: settled.settledOptionId, adminResolved: true },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
