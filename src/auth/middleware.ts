import type { RequestHandler } from 'express';
import { getFirebaseAuth } from './firebase.js';
import { unauthorized } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      user?: { uid: string; email: string; name: string };
    }
  }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('Missing or malformed Authorization header'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(unauthorized('Empty bearer token'));
    return;
  }
  try {
    const decoded = await getFirebaseAuth().verifyIdToken(token);
    if (!decoded.email) {
      next(unauthorized('Token has no email claim'));
      return;
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: typeof decoded.name === 'string' && decoded.name.length > 0 ? decoded.name : decoded.email,
    };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
};
