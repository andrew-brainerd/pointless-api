import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

let client: MongoClient | undefined;
let db: Db | undefined;
let indexesEnsured = false;

export const getMongoClient = async (): Promise<MongoClient> => {
  if (client) return client;
  const env = loadEnv();
  client = new MongoClient(env.MONGO_URI);
  await client.connect();
  logger.info({ uri: env.MONGO_URI.replace(/\/\/.*@/, '//***@') }, 'mongo connected');
  return client;
};

export const getDb = async (): Promise<Db> => {
  if (db && indexesEnsured) return db;
  const env = loadEnv();
  const c = await getMongoClient();
  db = c.db(env.MONGO_DB_NAME);
  if (!indexesEnsured) {
    await ensureIndexes(db);
    indexesEnsured = true;
  }
  return db;
};

export const closeMongo = async (): Promise<void> => {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
    indexesEnsured = false;
  }
};

const ensureIndexes = async (db: Db): Promise<void> => {
  await db.collection('pools').createIndex({ memberUids: 1 });
  await db.collection('pools').createIndex(
    { createdBy: 1, name: 1 },
    { unique: true, name: 'pools_createdBy_name_unique' },
  );
  await db.collection('pool_invites').createIndex({ invitedUid: 1, status: 1 });
  await db.collection('pool_invites').createIndex({ invitedEmail: 1, status: 1 });
  await db.collection('pool_invites').createIndex({ poolId: 1, status: 1 });
  await db.collection('users').createIndex({ email: 1 });
  await db.collection('wagers').createIndex({ poolId: 1, status: 1 });
  await db.collection('wagers').createIndex({ poolId: 1, 'participants.uid': 1 });
  await db
    .collection('notifications')
    .createIndex({ userUid: 1, isDismissed: 1, createdAt: -1 });
};

// FR-04: all wager point movements must be atomic. Wrap an operation in a
// Mongo transaction; all collection ops inside `fn` should pass `{ session }`.
export const withTransaction = async <T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const client = await getMongoClient();
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
