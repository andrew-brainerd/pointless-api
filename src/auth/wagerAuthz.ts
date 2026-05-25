import { ObjectId } from 'mongodb';
import type { RequestHandler } from 'express';
import { getWager, type WagerDoc } from '../data/wagers.js';
import { getPool, type PoolDoc } from '../data/pools.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      wager?: WagerDoc;
    }
  }
}

// Loads the wager from :wagerId, then loads the wager's pool, then asserts
// the requesting user is a member of that pool. 404 for non-members and for
// missing wagers (avoids leaking existence).
export const requireWagerVisible: RequestHandler = async (req, _res, next) => {
  try {
    const raw = req.params.wagerId;
    if (typeof raw !== 'string' || !ObjectId.isValid(raw)) {
      next(badRequest('Invalid wagerId'));
      return;
    }
    const wager = await getWager(new ObjectId(raw));
    if (!wager) {
      next(notFound('Wager not found'));
      return;
    }
    const pool = await getPool(wager.poolId);
    const uid = req.user!.uid;
    if (!pool || !pool.members[uid]) {
      next(notFound('Wager not found'));
      return;
    }
    req.wager = wager;
    req.pool = pool;
    next();
  } catch (err) {
    next(err);
  }
};

// Must run after requireWagerVisible.
export const requireWagerPoolAdmin: RequestHandler = (req, _res, next) => {
  const uid = req.user!.uid;
  if ((req.pool as PoolDoc).members[uid]?.role !== 'admin') {
    next(forbidden('Admins only'));
    return;
  }
  next();
};
