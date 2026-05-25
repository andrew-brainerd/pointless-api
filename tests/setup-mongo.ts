import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | undefined;

export const setup = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.MONGO_DB_NAME = 'pointless-test';
};

export const teardown = async (): Promise<void> => {
  await mongod?.stop();
};
