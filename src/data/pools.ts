import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db/mongo.js';
import { conflict } from '../lib/errors.js';

export type MemberRole = 'admin' | 'member';

export interface PoolMember {
  role: MemberRole;
  balance: number;
  pending: number;
  joinedAt: Date;
}

export interface PoolDoc {
  _id: ObjectId;
  name: string;
  createdBy: string;
  createdAt: Date;
  startingPoints: number;
  members: Record<string, PoolMember>;
  memberUids: string[];
}

export const poolsCollection = async (): Promise<Collection<PoolDoc>> => {
  const db = await getDb();
  return db.collection<PoolDoc>('pools');
};

export interface CreatePoolInput {
  name: string;
  createdBy: string;
  startingPoints: number;
}

export const createPool = async (input: CreatePoolInput): Promise<PoolDoc> => {
  const col = await poolsCollection();
  const now = new Date();
  const doc: PoolDoc = {
    _id: new ObjectId(),
    name: input.name,
    createdBy: input.createdBy,
    createdAt: now,
    startingPoints: input.startingPoints,
    members: {
      [input.createdBy]: {
        role: 'admin',
        balance: input.startingPoints,
        pending: 0,
        joinedAt: now,
      },
    },
    memberUids: [input.createdBy],
  };
  try {
    await col.insertOne(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict(`You already have a pool named "${input.name}"`);
    }
    throw err;
  }
  return doc;
};

export const getPool = async (id: ObjectId): Promise<PoolDoc | null> => {
  const col = await poolsCollection();
  return col.findOne({ _id: id });
};

export const listPoolsForUser = async (uid: string): Promise<WithId<PoolDoc>[]> => {
  const col = await poolsCollection();
  return col.find({ memberUids: uid }).sort({ createdAt: -1 }).toArray();
};

export interface UpdatePoolConfigInput {
  name?: string;
  startingPoints?: number;
}

export const updatePoolConfig = async (
  id: ObjectId,
  patch: UpdatePoolConfigInput,
): Promise<PoolDoc> => {
  const col = await poolsCollection();
  const $set: Record<string, unknown> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.startingPoints !== undefined) $set.startingPoints = patch.startingPoints;
  try {
    const result = await col.findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'after' });
    if (!result) throw new Error('updatePoolConfig: pool not found');
    return result;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict(`You already have a pool named "${patch.name ?? ''}"`);
    }
    throw err;
  }
};

export const deletePool = async (id: ObjectId): Promise<void> => {
  const col = await poolsCollection();
  await col.deleteOne({ _id: id });
};

export interface AddMemberInput {
  poolId: ObjectId;
  uid: string;
  role: MemberRole;
}

export const addMember = async (input: AddMemberInput): Promise<PoolDoc> => {
  const col = await poolsCollection();
  const pool = await col.findOne({ _id: input.poolId });
  if (!pool) throw new Error('addMember: pool not found');
  if (pool.members[input.uid]) {
    // Already a member — return as-is.
    return pool;
  }
  const now = new Date();
  const member: PoolMember = {
    role: input.role,
    balance: pool.startingPoints,
    pending: 0,
    joinedAt: now,
  };
  const result = await col.findOneAndUpdate(
    { _id: input.poolId },
    {
      $set: { [`members.${input.uid}`]: member },
      $addToSet: { memberUids: input.uid },
    },
    { returnDocument: 'after' },
  );
  if (!result) throw new Error('addMember: pool vanished mid-update');
  return result;
};

export const removeMember = async (poolId: ObjectId, uid: string): Promise<PoolDoc | null> => {
  const col = await poolsCollection();
  return col.findOneAndUpdate(
    { _id: poolId },
    {
      $unset: { [`members.${uid}`]: '' },
      $pull: { memberUids: uid },
    },
    { returnDocument: 'after' },
  );
};

export const changeRole = async (
  poolId: ObjectId,
  uid: string,
  role: MemberRole,
): Promise<PoolDoc | null> => {
  const col = await poolsCollection();
  return col.findOneAndUpdate(
    { _id: poolId },
    { $set: { [`members.${uid}.role`]: role } },
    { returnDocument: 'after' },
  );
};

export const adminCount = (pool: PoolDoc): number =>
  Object.values(pool.members).filter(m => m.role === 'admin').length;

export const longestTenuredMember = (pool: PoolDoc): string | null => {
  const entries = Object.entries(pool.members);
  if (entries.length === 0) return null;
  return entries.reduce((best, current) =>
    current[1].joinedAt < best[1].joinedAt ? current : best,
  )[0];
};

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
