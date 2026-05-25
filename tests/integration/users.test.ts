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

const { createApp } = await import('../../src/app.js');
const { usersCollection } = await import('../../src/data/users.js');
const { closeMongo } = await import('../../src/db/mongo.js');

const app = createApp();
const BEARER = 'Bearer test-token';

const stubToken = (claims: { uid: string; email: string; name?: string }): void => {
  mockVerifyIdToken.mockResolvedValue(claims);
};

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  const col = await usersCollection();
  await col.deleteMany({});
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeMongo();
});

describe('POST /api/v1/users/sync', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).post('/api/v1/users/sync').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('creates a user from the token claims on first call', async () => {
    stubToken({ uid: 'uid-001', email: 'alice@example.com', name: 'Alice' });
    const res = await request(app).post('/api/v1/users/sync').set('Authorization', BEARER).send({});
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      _id: 'uid-001',
      email: 'alice@example.com',
      displayName: 'Alice',
      photoURL: null,
    });
    expect(res.body.user.createdAt).toBeDefined();
    expect(res.body.user.lastSeenAt).toBeDefined();
  });

  it('is idempotent on repeated calls and updates lastSeenAt', async () => {
    stubToken({ uid: 'uid-002', email: 'bob@example.com', name: 'Bob' });
    const first = await request(app).post('/api/v1/users/sync').set('Authorization', BEARER).send({});
    const firstSeen = new Date(first.body.user.lastSeenAt).getTime();

    await new Promise(r => setTimeout(r, 10));

    const second = await request(app).post('/api/v1/users/sync').set('Authorization', BEARER).send({});
    expect(second.status).toBe(200);
    expect(second.body.user._id).toBe('uid-002');
    expect(new Date(second.body.user.lastSeenAt).getTime()).toBeGreaterThanOrEqual(firstSeen);
    expect(second.body.user.createdAt).toBe(first.body.user.createdAt);

    const col = await usersCollection();
    const count = await col.countDocuments({ _id: 'uid-002' });
    expect(count).toBe(1);
  });

  it('refines displayName / photoURL from the request body', async () => {
    stubToken({ uid: 'uid-003', email: 'carol@example.com' });
    const res = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', BEARER)
      .send({ displayName: 'Carol the Great', photoURL: 'https://example.com/c.png' });
    expect(res.body.user.displayName).toBe('Carol the Great');
    expect(res.body.user.photoURL).toBe('https://example.com/c.png');
  });

  it('returns 422 for invalid body', async () => {
    stubToken({ uid: 'uid-004', email: 'dan@example.com' });
    const res = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', BEARER)
      .send({ photoURL: 'not-a-url' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('GET /api/v1/users/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user has not been synced', async () => {
    stubToken({ uid: 'uid-not-synced', email: 'ghost@example.com' });
    const res = await request(app).get('/api/v1/users/me').set('Authorization', BEARER);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns the synced user', async () => {
    stubToken({ uid: 'uid-005', email: 'eve@example.com', name: 'Eve' });
    await request(app).post('/api/v1/users/sync').set('Authorization', BEARER).send({});

    const res = await request(app).get('/api/v1/users/me').set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      _id: 'uid-005',
      email: 'eve@example.com',
      displayName: 'Eve',
    });
  });
});
