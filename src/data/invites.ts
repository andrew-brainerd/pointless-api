import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db/mongo.js';

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface InviteDoc {
  _id: ObjectId;
  poolId: ObjectId;
  invitedUid: string | null;
  invitedEmail: string;
  invitedBy: string;
  createdAt: Date;
  status: InviteStatus;
  resolvedAt: Date | null;
}

export const invitesCollection = async (): Promise<Collection<InviteDoc>> => {
  const db = await getDb();
  return db.collection<InviteDoc>('pool_invites');
};

export interface CreateInviteInput {
  poolId: ObjectId;
  invitedUid: string | null;
  invitedEmail: string;
  invitedBy: string;
}

export interface CreateInviteResult {
  invite: InviteDoc;
  created: boolean; // false if an existing pending invite matched (idempotent)
}

// FR-16: idempotent on re-invite of the same uid/email for the same pool.
export const createInvite = async (input: CreateInviteInput): Promise<CreateInviteResult> => {
  const col = await invitesCollection();
  const existing = await col.findOne({
    poolId: input.poolId,
    status: 'pending',
    $or: [
      input.invitedUid ? { invitedUid: input.invitedUid } : { invitedUid: null },
      { invitedEmail: input.invitedEmail.toLowerCase() },
    ],
  });
  if (existing) return { invite: existing, created: false };
  const doc: InviteDoc = {
    _id: new ObjectId(),
    poolId: input.poolId,
    invitedUid: input.invitedUid,
    invitedEmail: input.invitedEmail.toLowerCase(),
    invitedBy: input.invitedBy,
    createdAt: new Date(),
    status: 'pending',
    resolvedAt: null,
  };
  await col.insertOne(doc);
  return { invite: doc, created: true };
};

export const getInvite = async (id: ObjectId): Promise<InviteDoc | null> => {
  const col = await invitesCollection();
  return col.findOne({ _id: id });
};

export const listPendingInvitesForUid = async (uid: string): Promise<WithId<InviteDoc>[]> => {
  const col = await invitesCollection();
  return col.find({ invitedUid: uid, status: 'pending' }).sort({ createdAt: -1 }).toArray();
};

export const listInvitesForPool = async (poolId: ObjectId): Promise<WithId<InviteDoc>[]> => {
  const col = await invitesCollection();
  return col.find({ poolId, status: 'pending' }).sort({ createdAt: -1 }).toArray();
};

export const markInviteStatus = async (
  id: ObjectId,
  status: Exclude<InviteStatus, 'pending'>,
): Promise<InviteDoc | null> => {
  const col = await invitesCollection();
  return col.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status, resolvedAt: new Date() } },
    { returnDocument: 'after' },
  );
};

// C-2: when a user signs in for the first time (POST /users/sync), resolve any
// pending invites that were created against their email before they had a uid.
// Idempotent. Returns the count of invites updated.
export const resolveInvitesForEmail = async (email: string, uid: string): Promise<number> => {
  const col = await invitesCollection();
  const result = await col.updateMany(
    { invitedEmail: email.toLowerCase(), invitedUid: null, status: 'pending' },
    { $set: { invitedUid: uid } },
  );
  return result.modifiedCount;
};

export const tieInviteToUid = async (id: ObjectId, uid: string): Promise<void> => {
  const col = await invitesCollection();
  await col.updateOne({ _id: id }, { $set: { invitedUid: uid } });
};
