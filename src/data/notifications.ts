import { ObjectId, type Collection } from 'mongodb';
import { getDb } from '../db/mongo.js';

export type NotificationType =
  | 'pool_invite'
  | 'wager_invite'
  | 'wager_resolution_proposed'
  | 'wager_settled'
  | 'wager_disputed'
  | 'wager_voided'
  | 'member_joined'
  | 'member_left';

export interface NotificationDoc {
  _id: ObjectId;
  userUid: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: Date;
}

export const notificationsCollection = async (): Promise<Collection<NotificationDoc>> => {
  const db = await getDb();
  return db.collection<NotificationDoc>('notifications');
};

export interface CreateNotificationInput {
  userUid: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
  payload?: Record<string, unknown>;
}

export const createNotifications = async (
  inputs: CreateNotificationInput[],
): Promise<NotificationDoc[]> => {
  if (inputs.length === 0) return [];
  const col = await notificationsCollection();
  const now = new Date();
  const docs: NotificationDoc[] = inputs.map(input => ({
    _id: new ObjectId(),
    userUid: input.userUid,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
    payload: input.payload ?? {},
    isRead: false,
    isDismissed: false,
    createdAt: now,
  }));
  await col.insertMany(docs);
  return docs;
};

export interface ListNotificationsOptions {
  includeRead?: boolean;
  limit?: number;
}

export const listNotificationsForUser = async (
  uid: string,
  opts: ListNotificationsOptions = {},
): Promise<NotificationDoc[]> => {
  const col = await notificationsCollection();
  const filter: Record<string, unknown> = { userUid: uid, isDismissed: false };
  if (!opts.includeRead) filter.isRead = false;
  return col
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 100)
    .toArray();
};

export const markNotificationRead = async (
  id: ObjectId,
  uid: string,
): Promise<NotificationDoc | null> => {
  const col = await notificationsCollection();
  return col.findOneAndUpdate(
    { _id: id, userUid: uid },
    { $set: { isRead: true } },
    { returnDocument: 'after' },
  );
};

export const dismissNotification = async (
  id: ObjectId,
  uid: string,
): Promise<NotificationDoc | null> => {
  const col = await notificationsCollection();
  return col.findOneAndUpdate(
    { _id: id, userUid: uid },
    { $set: { isDismissed: true } },
    { returnDocument: 'after' },
  );
};

export const markAllRead = async (uid: string): Promise<number> => {
  const col = await notificationsCollection();
  const result = await col.updateMany(
    { userUid: uid, isRead: false, isDismissed: false },
    { $set: { isRead: true } },
  );
  return result.modifiedCount;
};
