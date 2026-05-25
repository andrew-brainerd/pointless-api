import { ObjectId } from 'mongodb';
import type { RequestHandler } from 'express';
import { getPool, type PoolDoc } from '../data/pools.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      pool?: PoolDoc;
    }
  }
}

// Loads the pool from :poolId and asserts the requesting user is a member.
// Returns 404 (not 403) for non-members to avoid leaking pool existence.
export const requirePoolMember: RequestHandler = async (req, _res, next) => {
  try {
    const raw = req.params.poolId;
    if (typeof raw !== 'string' || !ObjectId.isValid(raw)) {
      next(badRequest('Invalid poolId'));
      return;
    }
    const pool = await getPool(new ObjectId(raw));
    const uid = req.user!.uid;
    if (!pool || !pool.members[uid]) {
      next(notFound('Pool not found'));
      return;
    }
    req.pool = pool;
    next();
  } catch (err) {
    next(err);
  }
};

// Must run after requirePoolMember.
export const requirePoolAdmin: RequestHandler = (req, _res, next) => {
  const uid = req.user!.uid;
  const member = req.pool!.members[uid];
  if (member?.role !== 'admin') {
    next(forbidden('Admins only'));
    return;
  }
  next();
};
