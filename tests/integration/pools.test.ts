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
const { usersCollection, upsertUser } = await import('../../src/data/users.js');
const { closeMongo } = await import('../../src/db/mongo.js');

const app = createApp();
const BEARER = 'Bearer test-token';

interface Identity {
  uid: string;
  email: string;
  name: string;
}

let current: Identity = { uid: 'admin-1', email: 'admin@example.com', name: 'Admin' };

const as = (uid: string, email: string, name: string): void => {
  current = { uid, email, name };
};

const createTestUser = async (uid: string, email: string, name: string) => {
  await upsertUser(uid, { email, displayName: name, photoURL: null });
};

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockImplementation(() => Promise.resolve(current));
  current = { uid: 'admin-1', email: 'admin@example.com', name: 'Admin' };
  await (await poolsCollection()).deleteMany({});
  await (await invitesCollection()).deleteMany({});
  await (await usersCollection()).deleteMany({});
  await createTestUser('admin-1', 'admin@example.com', 'Admin');
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeMongo();
});

const createPoolRequest = (name = 'My Pool', startingPoints?: number) => {
  const body: Record<string, unknown> = { name };
  if (startingPoints !== undefined) body.startingPoints = startingPoints;
  return request(app).post('/api/v1/pools').set('Authorization', BEARER).send(body);
};

describe('POST /api/v1/pools', () => {
  it('creates a pool with the creator as the sole admin (default starting points 500)', async () => {
    const res = await createPoolRequest('Test Pool');
    expect(res.status).toBe(201);
    expect(res.body.pool).toMatchObject({
      name: 'Test Pool',
      createdBy: 'admin-1',
      startingPoints: 500,
    });
    expect(res.body.pool.members['admin-1']).toMatchObject({
      role: 'admin',
      balance: 500,
      pending: 0,
    });
    expect(res.body.pool.memberUids).toEqual(['admin-1']);
  });

  it('accepts a custom startingPoints value', async () => {
    const res = await createPoolRequest('High Stakes', 10_000);
    expect(res.body.pool.startingPoints).toBe(10_000);
    expect(res.body.pool.members['admin-1'].balance).toBe(10_000);
  });

  it('rejects a duplicate pool name from the same creator with 409', async () => {
    await createPoolRequest('Duplicate');
    const res = await createPoolRequest('Duplicate');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('allows the same name from a different creator', async () => {
    await createPoolRequest('Shared Name');
    await createTestUser('other-1', 'other@example.com', 'Other');
    as('other-1', 'other@example.com', 'Other');
    const res = await createPoolRequest('Shared Name');
    expect(res.status).toBe(201);
  });

  it('rejects empty name with 422', async () => {
    const res = await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name: '' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/pools', () => {
  it('returns only pools the user is a member of', async () => {
    await createPoolRequest('Mine');

    await createTestUser('other-1', 'other@example.com', 'Other');
    as('other-1', 'other@example.com', 'Other');
    await createPoolRequest('Theirs');

    as('admin-1', 'admin@example.com', 'Admin');
    const res = await request(app).get('/api/v1/pools').set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.pools).toHaveLength(1);
    expect(res.body.pools[0].name).toBe('Mine');
  });
});

describe('GET /api/v1/pools/:poolId', () => {
  it('returns the pool for a member', async () => {
    const created = await createPoolRequest('Members Only');
    const res = await request(app)
      .get(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.pool.name).toBe('Members Only');
  });

  it('returns 404 for non-members (does not leak pool existence)', async () => {
    const created = await createPoolRequest('Members Only');
    await createTestUser('stranger-1', 'stranger@example.com', 'Stranger');
    as('stranger-1', 'stranger@example.com', 'Stranger');
    const res = await request(app)
      .get(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid ObjectId', async () => {
    const res = await request(app).get('/api/v1/pools/not-an-id').set('Authorization', BEARER);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/pools/:poolId', () => {
  it('admin updates name + startingPoints; existing balances unchanged', async () => {
    const created = await createPoolRequest('Original', 500);
    const res = await request(app)
      .patch(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER)
      .send({ name: 'Renamed', startingPoints: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.pool.name).toBe('Renamed');
    expect(res.body.pool.startingPoints).toBe(1000);
    // Admin's existing balance not touched (US-12.2 — applies only to future joiners).
    expect(res.body.pool.members['admin-1'].balance).toBe(500);
  });

  it('blocks non-admin members with 403', async () => {
    const created = await createPoolRequest('Pool');
    await createTestUser('member-1', 'member@example.com', 'Member');
    const invite = await request(app)
      .post(`/api/v1/pools/${created.body.pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'member-1' });
    as('member-1', 'member@example.com', 'Member');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);

    const res = await request(app)
      .patch(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER)
      .send({ name: 'Hijack' });
    expect(res.status).toBe(403);
  });

  it('rejects an empty patch body with 400', async () => {
    const created = await createPoolRequest('Pool');
    const res = await request(app)
      .patch(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/pools/:poolId', () => {
  it('admin deletes the pool', async () => {
    const created = await createPoolRequest('Doomed');
    const res = await request(app)
      .delete(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(204);
    const after = await request(app)
      .get(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER);
    expect(after.status).toBe(404);
  });
});

describe('Membership: leave + remove + role change', () => {
  // Helper to set up an admin + one member. Leaves identity as admin-1 so
  // tests start from the admin's perspective and switch explicitly when needed.
  const setupTwo = async () => {
    const pool = (await createPoolRequest('Two-Person')).body.pool;
    await createTestUser('member-1', 'member@example.com', 'Member');
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'member-1' });
    as('member-1', 'member@example.com', 'Member');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    as('admin-1', 'admin@example.com', 'Admin');
    return pool;
  };

  it('member can leave; admin remains', async () => {
    const pool = await setupTwo();
    as('member-1', 'member@example.com', 'Member');
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/leave`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(204);
    as('admin-1', 'admin@example.com', 'Admin');
    const after = await request(app).get(`/api/v1/pools/${pool._id}`).set('Authorization', BEARER);
    expect(after.body.pool.memberUids).toEqual(['admin-1']);
  });

  it('last admin cannot leave while other members remain', async () => {
    const pool = await setupTwo();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/leave`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(409);
  });

  it('admin can remove a non-admin member', async () => {
    const pool = await setupTwo();
    const res = await request(app)
      .delete(`/api/v1/pools/${pool._id}/members/member-1`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(204);
  });

  it('admin cannot remove themselves via the remove endpoint', async () => {
    const pool = await setupTwo();
    const res = await request(app)
      .delete(`/api/v1/pools/${pool._id}/members/admin-1`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(400);
  });

  it('promotes a member to admin then the original admin can leave', async () => {
    const pool = await setupTwo();
    let res = await request(app)
      .patch(`/api/v1/pools/${pool._id}/members/member-1/role`)
      .set('Authorization', BEARER)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    res = await request(app).post(`/api/v1/pools/${pool._id}/leave`).set('Authorization', BEARER);
    expect(res.status).toBe(204);
  });

  it('cannot demote the last admin', async () => {
    const pool = await setupTwo();
    const res = await request(app)
      .patch(`/api/v1/pools/${pool._id}/members/admin-1/role`)
      .set('Authorization', BEARER)
      .send({ role: 'member' });
    expect(res.status).toBe(409);
  });

  it('sole member leaving auto-deletes the pool', async () => {
    const created = await createPoolRequest('Solo');
    const res = await request(app)
      .post(`/api/v1/pools/${created.body.pool._id}/leave`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(204);
    const after = await request(app)
      .get(`/api/v1/pools/${created.body.pool._id}`)
      .set('Authorization', BEARER);
    expect(after.status).toBe(404);
  });

  it('new joiners get the current startingPoints config, not the original', async () => {
    const pool = (await createPoolRequest('Adjustable', 500)).body.pool;
    await request(app)
      .patch(`/api/v1/pools/${pool._id}`)
      .set('Authorization', BEARER)
      .send({ startingPoints: 2000 });
    await createTestUser('late-1', 'late@example.com', 'Latecomer');
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'late-1' });
    as('late-1', 'late@example.com', 'Latecomer');
    const accepted = await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    expect(accepted.body.pool.members['late-1'].balance).toBe(2000);
    expect(accepted.body.pool.members['admin-1'].balance).toBe(500);
  });
});
