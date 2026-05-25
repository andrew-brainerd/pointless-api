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
const { notificationsCollection } = await import('../../src/data/notifications.js');
const { usersCollection, upsertUser } = await import('../../src/data/users.js');
const { closeMongo } = await import('../../src/db/mongo.js');

const app = createApp();
const BEARER = 'Bearer test-token';

let current = { uid: 'alice', email: 'alice@example.com', name: 'Alice' };
const as = (uid: string, email: string, name: string): void => {
  current = { uid, email, name };
};

const createTestUser = (uid: string, email: string, name: string) =>
  upsertUser(uid, { email, displayName: name, photoURL: null });

// notify() is fire-and-forget. Give it a tick to land DB writes before asserting.
const tick = () => new Promise(r => setTimeout(r, 50));

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockImplementation(() => Promise.resolve(current));
  current = { uid: 'alice', email: 'alice@example.com', name: 'Alice' };
  await (await poolsCollection()).deleteMany({});
  await (await invitesCollection()).deleteMany({});
  await (await wagersCollection()).deleteMany({});
  await (await notificationsCollection()).deleteMany({});
  await (await usersCollection()).deleteMany({});
  await createTestUser('alice', 'alice@example.com', 'Alice');
  await createTestUser('bob', 'bob@example.com', 'Bob');
  await createTestUser('carol', 'carol@example.com', 'Carol');
});

afterEach(() => vi.clearAllMocks());
afterAll(async () => closeMongo());

const setupThreePool = async () => {
  const pool = (
    await request(app)
      .post('/api/v1/pools')
      .set('Authorization', BEARER)
      .send({ name: 'Pool' })
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

describe('GET /api/v1/notifications', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('returns the user\'s own unread notifications, newest first', async () => {
    await createTestUser('bob', 'bob@example.com', 'Bob');
    const pool = await request(app)
      .post('/api/v1/pools')
      .set('Authorization', BEARER)
      .send({ name: 'X' });
    await request(app)
      .post(`/api/v1/pools/${pool.body.pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob' });
    await tick();

    as('bob', 'bob@example.com', 'Bob');
    const res = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.notifications.length).toBeGreaterThanOrEqual(1);
    const types = (res.body.notifications as Array<{ type: string }>).map(n => n.type);
    expect(types).toContain('pool_invite');
  });
});

describe('Wager fan-out creates notifications', () => {
  it('POST /pools/:poolId/wagers creates a wager_invite notification for each invited', async () => {
    const pool = await setupThreePool();
    await request(app)
      .post(`/api/v1/pools/${pool._id}/wagers`)
      .set('Authorization', BEARER)
      .send({
        description: 'Will it rain?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        myOptionId: 'yes',
        myStake: 50,
      });
    await tick();

    const col = await notificationsCollection();
    const bobNotifs = await col.find({ userUid: 'bob', type: 'wager_invite' }).toArray();
    const carolNotifs = await col.find({ userUid: 'carol', type: 'wager_invite' }).toArray();
    expect(bobNotifs).toHaveLength(1);
    expect(carolNotifs).toHaveLength(1);
    expect(bobNotifs[0]!.body).toContain('Will it rain?');
  });

  it('settling a wager (creator-proposes / all-confirm) fans out wager_settled to all staked', async () => {
    const pool = await setupThreePool();
    const wager = (
      await request(app)
        .post(`/api/v1/pools/${pool._id}/wagers`)
        .set('Authorization', BEARER)
        .send({
          description: 'Test',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
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
    as('bob', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/wagers/${wager._id}/confirm-resolution`)
      .set('Authorization', BEARER);
    await tick();

    const col = await notificationsCollection();
    const settled = await col.find({ type: 'wager_settled' }).toArray();
    expect(settled.map(n => n.userUid).sort()).toEqual(['alice', 'bob']);
  });
});

describe('PATCH /api/v1/notifications/:id/read + /dismiss + /read-all', () => {
  it('marks one notification as read', async () => {
    await createTestUser('bob', 'bob@example.com', 'Bob');
    const pool = (
      await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name: 'P' })
    ).body.pool;
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob' });
    await tick();

    as('bob', 'bob@example.com', 'Bob');
    const list = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    const id = (list.body.notifications as Array<{ _id: string }>)[0]!._id;
    const read = await request(app)
      .patch(`/api/v1/notifications/${id}/read`)
      .set('Authorization', BEARER);
    expect(read.status).toBe(200);
    expect(read.body.notification.isRead).toBe(true);

    const after = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    expect(after.body.notifications).toHaveLength(0);
  });

  it('dismisses a notification (hides it even from includeRead lists)', async () => {
    await createTestUser('bob', 'bob@example.com', 'Bob');
    const pool = (
      await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name: 'P' })
    ).body.pool;
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob' });
    await tick();

    as('bob', 'bob@example.com', 'Bob');
    const list = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    const id = (list.body.notifications as Array<{ _id: string }>)[0]!._id;
    await request(app).patch(`/api/v1/notifications/${id}/dismiss`).set('Authorization', BEARER);

    const after = await request(app)
      .get('/api/v1/notifications?includeRead=true')
      .set('Authorization', BEARER);
    expect(after.body.notifications).toHaveLength(0);
  });

  it('cannot read another user\'s notification', async () => {
    await createTestUser('bob', 'bob@example.com', 'Bob');
    const pool = (
      await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name: 'P' })
    ).body.pool;
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob' });
    await tick();
    as('bob', 'bob@example.com', 'Bob');
    const list = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    const bobNotifId = (list.body.notifications as Array<{ _id: string }>)[0]!._id;

    as('alice', 'alice@example.com', 'Alice');
    const res = await request(app)
      .patch(`/api/v1/notifications/${bobNotifId}/read`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(404);
  });

  it('PATCH /read-all marks every unread notification as read', async () => {
    await createTestUser('bob', 'bob@example.com', 'Bob');
    const pool = (
      await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name: 'P' })
    ).body.pool;
    // generate 2 notifications by inviting then having bob accept (which fires member.joined)
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob' });
    await tick();
    as('bob', 'bob@example.com', 'Bob');
    const res = await request(app).patch('/api/v1/notifications/read-all').set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const after = await request(app).get('/api/v1/notifications').set('Authorization', BEARER);
    expect(after.body.notifications).toHaveLength(0);
  });
});

describe('POST /api/v1/pusher/auth', () => {
  it('returns 400 when Pusher is not configured (test env)', async () => {
    // No PUSHER_* env vars in test setup → Pusher init returns undefined → 400.
    const pool = await setupThreePool();
    const res = await request(app)
      .post('/api/v1/pusher/auth')
      .set('Authorization', BEARER)
      .send({
        socket_id: '123.456',
        channel_name: `private-pool-${pool._id}`,
      });
    expect(res.status).toBe(400);
  });

  it('rejects non-member subscribing to a pool channel with 403', async () => {
    const pool = await setupThreePool();
    await createTestUser('stranger', 'stranger@example.com', 'Stranger');
    as('stranger', 'stranger@example.com', 'Stranger');
    const res = await request(app)
      .post('/api/v1/pusher/auth')
      .set('Authorization', BEARER)
      .send({
        socket_id: '123.456',
        channel_name: `private-pool-${pool._id}`,
      });
    expect(res.status).toBe(403);
  });

  it('rejects subscribing to another user\'s private channel with 403', async () => {
    const res = await request(app)
      .post('/api/v1/pusher/auth')
      .set('Authorization', BEARER)
      .send({
        socket_id: '123.456',
        channel_name: 'private-user-someone-else',
      });
    expect(res.status).toBe(403);
  });

  it('rejects unknown channel namespaces with 403', async () => {
    const res = await request(app)
      .post('/api/v1/pusher/auth')
      .set('Authorization', BEARER)
      .send({
        socket_id: '123.456',
        channel_name: 'private-foobar-123',
      });
    expect(res.status).toBe(403);
  });
});
