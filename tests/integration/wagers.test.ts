import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { mockVerifyIdToken } = vi.hoisted(() => ({ mockVerifyIdToken: vi.fn() }));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ options: { projectId: 'test-project' } })),
  applicationDefault: vi.fn(),
  getApps: vi.fn(() => []),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: vi.fn(), send: vi.fn().mockResolvedValue([{ statusCode: 202 }]) },
}));

const { createApp } = await import('../../src/app.js');
const { poolsCollection } = await import('../../src/data/pools.js');
const { invitesCollection } = await import('../../src/data/invites.js');
const { wagersCollection } = await import('../../src/data/wagers.js');
const { usersCollection, upsertUser } = await import('../../src/data/users.js');
const { closeMongo } = await import('../../src/db/mongo.js');

const app = createApp();
const BEARER = 'Bearer test-token';

interface Identity {
  uid: string;
  email: string;
  name: string;
}

let current: Identity = { uid: 'alice', email: 'alice@example.com', name: 'Alice' };

const as = (uid: string, email: string, name: string): void => {
  current = { uid, email, name };
};

const createTestUser = (uid: string, email: string, name: string) =>
  upsertUser(uid, { email, displayName: name, photoURL: null });

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockImplementation(() => Promise.resolve(current));
  current = { uid: 'alice', email: 'alice@example.com', name: 'Alice' };
  await (await poolsCollection()).deleteMany({});
  await (await invitesCollection()).deleteMany({});
  await (await wagersCollection()).deleteMany({});
  await (await usersCollection()).deleteMany({});
  await createTestUser('alice', 'alice@example.com', 'Alice');
  await createTestUser('bob', 'bob@example.com', 'Bob');
  await createTestUser('carol', 'carol@example.com', 'Carol');
});

afterEach(() => vi.clearAllMocks());
afterAll(async () => closeMongo());

// Create a pool with alice (admin) + bob + carol, all starting at 500.
const setupThreePool = async (): Promise<{ _id: string }> => {
  const pool = (
    await request(app)
      .post('/api/v1/pools')
      .set('Authorization', BEARER)
      .send({ name: 'Test Pool' })
  ).body.pool;

  for (const uid of ['bob', 'carol']) {
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: uid });
    const prev = current;
    as(uid, `${uid}@example.com`, uid);
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    current = prev;
  }
  return pool;
};

const optYes = { id: 'yes', label: 'Yes' };
const optNo = { id: 'no', label: 'No' };

describe('POST /api/v1/pools/:poolId/wagers — create', () => {
  it('creates a wager and deducts creator stake to pending', async () => {
    const pool = await setupThreePool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/wagers`)
      .set('Authorization', BEARER)
      .send({
        description: 'Will it rain?',
        options: [optYes, optNo],
        myOptionId: 'yes',
        myStake: 100,
      });
    expect(res.status).toBe(201);
    expect(res.body.wager).toMatchObject({
      status: 'proposed',
      createdBy: 'alice',
      description: 'Will it rain?',
    });
    expect(res.body.wager.participants).toHaveLength(1);
    expect(res.body.wager.invitedUids.sort()).toEqual(['bob', 'carol']);

    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.alice.balance).toBe(400);
    expect(poolAfter.body.pool.members.alice.pending).toBe(100);
  });

  it('rejects a stake exceeding available balance with 400', async () => {
    const pool = await setupThreePool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/wagers`)
      .set('Authorization', BEARER)
      .send({
        description: 'Big bet',
        options: [optYes, optNo],
        myOptionId: 'yes',
        myStake: 600,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exceeds available/i);
  });

  it('rejects myOptionId not in options with 422', async () => {
    const pool = await setupThreePool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/wagers`)
      .set('Authorization', BEARER)
      .send({
        description: 'Bad ref',
        options: [optYes, optNo],
        myOptionId: 'maybe',
        myStake: 50,
      });
    expect(res.status).toBe(422);
  });

  it('rejects when fewer than 2 options', async () => {
    const pool = await setupThreePool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/wagers`)
      .set('Authorization', BEARER)
      .send({
        description: 'One side',
        options: [optYes],
        myOptionId: 'yes',
        myStake: 50,
      });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/wagers/:wagerId/stake', () => {
  const seedWager = async (pool: { _id: string }) =>
    (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Test',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;

  it('lets an invited participant stake; flips status to active once 2 options have backers', async () => {
    const pool = await setupThreePool();
    const wager = await seedWager(pool);
    as('bob', 'bob@example.com', 'Bob');
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 200 });
    expect(res.status).toBe(200);
    expect(res.body.wager.status).toBe('active');
    expect(res.body.wager.participants).toHaveLength(2);
    expect(res.body.wager.invitedUids).toEqual(['carol']);

    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.bob.balance).toBe(300);
    expect(poolAfter.body.pool.members.bob.pending).toBe(200);
  });

  it('rejects double-stake on the same wager with 409', async () => {
    const pool = await setupThreePool();
    const wager = await seedWager(pool);
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 50 });
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 25 });
    expect(res.status).toBe(409);
  });

  it('rejects stake from a non-invited pool member with 403', async () => {
    const pool = (
      await request(app)
        .post('/api/v1/pools')
        .set('Authorization', BEARER)
        .send({ name: 'Restricted' })
    ).body.pool;
    // invite only bob
    for (const uid of ['bob', 'carol']) {
      const invite = await request(app)
        .post(`/api/v1/pools/${pool._id}/invites`)
        .set('Authorization', BEARER)
        .send({ invitedUid: uid });
      const prev = current;
      as(uid, `${uid}@example.com`, uid);
      await request(app)
        .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
        .set('Authorization', BEARER);
      current = prev;
    }
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Bob-only',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 50,
          invitedUids: ['bob'],
        })
    ).body.wager;

    as('carol', 'carol@example.com', 'Carol');
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 10 });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/wagers/:wagerId/cancel', () => {
  it('creator cancels a proposed wager; stake is refunded', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Oopsie',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;

    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/cancel`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.wager.status).toBe('voided');
    expect(res.body.wager.voidReason).toBe('cancelled');

    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.alice.balance).toBe(500);
    expect(poolAfter.body.pool.members.alice.pending).toBe(0);
  });

  it('non-creator gets 403', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Mine',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 50,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/cancel`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(403);
  });

  it('cannot cancel after wager becomes active', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Active',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 100 });

    as('alice', 'alice@example.com', 'Alice');
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/cancel`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(409);
  });
});

describe('Resolution flow (propose + confirm + settle)', () => {
  it('1v1 settle: winner takes the full pot; loser pays out 0', async () => {
    const pool = await setupThreePool();
    // alice (100 on yes), bob (100 on no) — pot 200
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Will it rain?',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
          invitedUids: ['bob'],
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 100 });

    // alice proposes yes; bob confirms; settle
    as('alice', 'alice@example.com', 'Alice');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/propose-resolution`)
      .set('Authorization', BEARER)
      .send({ optionId: 'yes' });
    as('bob', 'bob@example.com', 'Bob');
    const settle = await request(app)
      .post(`/api/v1/wagers/${wager._id}/confirm-resolution`)
      .set('Authorization', BEARER);
    expect(settle.status).toBe(200);
    expect(settle.body.wager.status).toBe('settled');
    expect(settle.body.wager.settledOptionId).toBe('yes');

    as('alice', 'alice@example.com', 'Alice');
    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.alice.balance).toBe(600); // 400 + 200 payout
    expect(poolAfter.body.pool.members.alice.pending).toBe(0);
    expect(poolAfter.body.pool.members.bob.balance).toBe(400); // 400 + 0 payout
    expect(poolAfter.body.pool.members.bob.pending).toBe(0);
  });

  it('a single dispute moves the wager to disputed; admin resolves it', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Contested',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 100 });
    as('alice', 'alice@example.com', 'Alice');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/propose-resolution`)
      .set('Authorization', BEARER)
      .send({ optionId: 'yes' });
    as('bob', 'bob@example.com', 'Bob');
    const dispute = await request(app)
      .post(`/api/v1/wagers/${wager._id}/dispute-resolution`)
      .set('Authorization', BEARER);
    expect(dispute.body.wager.status).toBe('disputed');

    // Admin (alice) overrides to no — bob wins.
    as('alice', 'alice@example.com', 'Alice');
    const resolve = await request(app)
      .post(`/api/v1/wagers/${wager._id}/admin-resolve`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.wager.status).toBe('settled');
    expect(resolve.body.wager.settledOptionId).toBe('no');

    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.alice.balance).toBe(400); // forfeit
    expect(poolAfter.body.pool.members.bob.balance).toBe(600); // won pot
  });

  it('admin can void a disputed wager — all stakes refunded', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Void me',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 75,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 50 });
    as('alice', 'alice@example.com', 'Alice');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/propose-resolution`)
      .set('Authorization', BEARER)
      .send({ optionId: 'yes' });
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/dispute-resolution`)
      .set('Authorization', BEARER);

    as('alice', 'alice@example.com', 'Alice');
    const voided = await request(app)
      .post(`/api/v1/wagers/${wager._id}/admin-resolve`)
      .set('Authorization', BEARER)
      .send({ void: true });
    expect(voided.body.wager.status).toBe('voided');
    expect(voided.body.wager.voidReason).toBe('admin_void');

    const poolAfter = await request(app)
      .get(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER);
    expect(poolAfter.body.pool.members.alice.balance).toBe(500);
    expect(poolAfter.body.pool.members.bob.balance).toBe(500);
  });

  it('proposer cannot confirm their own proposal', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Self-confirm',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 50,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 50 });
    as('alice', 'alice@example.com', 'Alice');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/propose-resolution`)
      .set('Authorization', BEARER)
      .send({ optionId: 'yes' });
    const res = await request(app)
      .post(`/api/v1/wagers/${wager._id}/confirm-resolution`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(400);
  });
});

describe('D-3: leave-mid-wager handler', () => {
  it('leaving with a stake in a proposed wager voids the wager and refunds remaining participants', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Sole creator',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;

    // alice leaves while as the only participant
    const leave = await request(app)
      .post(`/api/v1/pools/${pool._id}/leave`)
      .set('Authorization', BEARER);
    // alice was last admin while bob+carol present → 409
    expect(leave.status).toBe(409);

    // Promote bob to admin, then alice leaves
    await request(app)
      .patch(`/api/v1/pools/${pool._id}/members/bob/role`)
      .set('Authorization', BEARER)
      .send({ role: 'admin' });
    const ok = await request(app)
      .post(`/api/v1/pools/${pool._id}/leave`)
      .set('Authorization', BEARER);
    expect(ok.status).toBe(204);

    as('bob', 'bob@example.com', 'Bob');
    const wagerAfter = await request(app)
      .get(`/api/v1/wagers/${wager._id}`)
      .set('Authorization', BEARER);
    expect(wagerAfter.body.wager.status).toBe('voided');
    expect(wagerAfter.body.wager.voidReason).toBe('last_member_left');
  });

  it('leaving an active wager with 2+ remaining keeps the wager going (without the leaver)', async () => {
    const pool = await setupThreePool();
    // alice stakes on yes, bob + carol stake on no — 3 participants
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Group',
          options: [optYes, optNo],
          myOptionId: 'yes',
          myStake: 100,
        })
    ).body.wager;
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 50 });
    as('carol', 'carol@example.com', 'Carol');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/stake`)
      .set('Authorization', BEARER)
      .send({ optionId: 'no', stake: 50 });

    // Carol leaves. Wager has bob + alice remaining (2) → stays active, carol removed.
    const leave = await request(app)
      .post(`/api/v1/pools/${pool._id}/leave`)
      .set('Authorization', BEARER);
    expect(leave.status).toBe(204);

    as('alice', 'alice@example.com', 'Alice');
    const wagerAfter = await request(app)
      .get(`/api/v1/wagers/${wager._id}`)
      .set('Authorization', BEARER);
    expect(wagerAfter.body.wager.status).toBe('active');
    expect(wagerAfter.body.wager.participants.map((p: { uid: string }) => p.uid).sort()).toEqual(
      ['alice', 'bob'],
    );
  });
});
