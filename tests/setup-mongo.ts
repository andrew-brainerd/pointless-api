import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod: MongoMemoryReplSet | undefined;

// Replica set mode so Mongo transactions (used by wager state changes per
// FR-04) work in tests. A single-node replica set is enough.
export const setup = async (): Promise<void> => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = mongod.getUri();
  process.env.MONGO_DB_NAME = 'pointless-test';
};

export const teardown = async (): Promise<void> => {
  await mongod?.stop();
};
