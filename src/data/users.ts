import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo.js';

export interface UserDoc {
  _id: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export const usersCollection = async (): Promise<Collection<UserDoc>> => {
  const db = await getDb();
  return db.collection<UserDoc>('users');
};

export interface UpsertUserPatch {
  email: string;
  displayName: string;
  photoURL?: string | null;
}

export const upsertUser = async (uid: string, patch: UpsertUserPatch): Promise<UserDoc> => {
  const col = await usersCollection();
  const now = new Date();
  const result = await col.findOneAndUpdate(
    { _id: uid },
    {
      $set: {
        email: patch.email.toLowerCase(),
        displayName: patch.displayName,
        photoURL: patch.photoURL ?? null,
        lastSeenAt: now,
      },
      $setOnInsert: { _id: uid, createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) {
    throw new Error('upsertUser: unexpected null result from findOneAndUpdate');
  }
  return result;
};

export const getUserByUid = async (uid: string): Promise<UserDoc | null> => {
  const col = await usersCollection();
  return col.findOne({ _id: uid });
};

export const getUserByEmail = async (email: string): Promise<UserDoc | null> => {
  const col = await usersCollection();
  return col.findOne({ email: email.toLowerCase() });
};
