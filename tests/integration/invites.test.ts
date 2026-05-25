import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { mockVerifyIdToken, mockSgSend } = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
  mockSgSend: vi.fn(),
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ options: { projectId: 'test-project' } })),
  applicationDefault: vi.fn(),
  getApps: vi.fn(() => []),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: vi.fn(), send: mockSgSend },
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
  mockSgSend.mockReset();
  mockSgSend.mockResolvedValue([{ statusCode: 202 }]);
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

const createPool = async (name = 'Pool A') => {
  const res = await request(app).post('/api/v1/pools').set('Authorization', BEARER).send({ name });
  return res.body.pool as { _id: string; name: string; startingPoints: number };
};

describe('POST /api/v1/pools/:poolId/invites', () => {
  it('admin invites by uid, invitee email is captured', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({
      invitedUid: 'bob-1',
      invitedEmail: 'bob@example.com',
      status: 'pending',
    });
    // No SendGrid for known users (FR-C, only emails for non-users).
    expect(mockSgSend).not.toHaveBeenCalled();
  });

  it('is idempotent on re-invite of the same uid', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_invited');
  });

  it('returns already_member if invitee is already in the pool', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);

    as('admin-1', 'admin@example.com', 'Admin');
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_member');
  });

  it('invites a non-user by email and sends a SendGrid invite email', async () => {
    const pool = await createPool('Email Test');
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedEmail: 'newbie@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({
      invitedUid: null,
      invitedEmail: 'newbie@example.com',
      status: 'pending',
    });
    expect(mockSgSend).toHaveBeenCalledOnce();
    const sent = mockSgSend.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(sent.to).toBe('newbie@example.com');
    expect(sent.subject).toContain('Email Test');
    expect(sent.html).toContain(`/invites/${res.body.invite._id}`);
  });

  it('attaches uid when invitee email matches an existing user', async () => {
    await createTestUser('carol-1', 'carol@example.com', 'Carol');
    const pool = await createPool();
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedEmail: 'carol@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.invite.invitedUid).toBe('carol-1');
    // SendGrid not called — invitee is already a known user.
    expect(mockSgSend).not.toHaveBeenCalled();
  });

  it('rejects an invite from a non-admin member with 403', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    await createTestUser('eve-1', 'eve@example.com', 'Eve');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);

    // bob (a non-admin member) tries to invite eve.
    const res = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'eve-1' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/pools/:poolId/invites/:inviteId (revoke)', () => {
  it('admin revokes a pending invite', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    const res = await request(app)
      .delete(`/api/v1/pools/${pool._id}/invites/${invite.body.invite._id}`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.invite.status).toBe('revoked');
  });

  it('cannot revoke an already-resolved invite', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/decline`)
      .set('Authorization', BEARER);

    as('admin-1', 'admin@example.com', 'Admin');
    const res = await request(app)
      .delete(`/api/v1/pools/${pool._id}/invites/${invite.body.invite._id}`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/v1/invites/:inviteId/accept', () => {
  it('adds the invitee as a member with starting points', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool('Acceptance');
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    const res = await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.invite.status).toBe('accepted');
    expect(res.body.pool.members['bob-1']).toMatchObject({
      role: 'member',
      balance: 500,
      pending: 0,
    });
  });

  it('forbids accepting someone else\'s invite', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    await createTestUser('eve-1', 'eve@example.com', 'Eve');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('eve-1', 'eve@example.com', 'Eve');
    const res = await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(403);
  });

  it('rejects accepting an invite twice with 409', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    const second = await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/accept`)
      .set('Authorization', BEARER);
    expect(second.status).toBe(409);
  });
});

describe('POST /api/v1/invites/:inviteId/decline', () => {
  it('marks the invite declined and does not add the user to the pool', async () => {
    await createTestUser('bob-1', 'bob@example.com', 'Bob');
    const pool = await createPool();
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedUid: 'bob-1' });
    as('bob-1', 'bob@example.com', 'Bob');
    const res = await request(app)
      .post(`/api/v1/invites/${invite.body.invite._id}/decline`)
      .set('Authorization', BEARER);
    expect(res.status).toBe(200);
    expect(res.body.invite.status).toBe('declined');

    as('admin-1', 'admin@example.com', 'Admin');
    const after = await request(app).get(`/api/v1/pools/${pool._id}`).set('Authorization', BEARER);
    expect(after.body.pool.members['bob-1']).toBeUndefined();
  });
});

describe('C-2: email-only invite resolution on /users/sync', () => {
  it('resolves a pending email invite to the new uid when the invitee first signs in', async () => {
    const pool = await createPool('Email Resolution');
    // Admin invites by email (invitee not yet a user).
    const invite = await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedEmail: 'newcomer@example.com' });
    expect(invite.body.invite.invitedUid).toBeNull();

    // Newcomer signs in for the first time.
    as('newcomer-1', 'newcomer@example.com', 'Newcomer');
    const sync = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', BEARER)
      .send({});
    expect(sync.status).toBe(200);
    expect(sync.body.resolvedInvites).toBe(1);

    // The invite is now tied to the newcomer's uid.
    const mine = await request(app).get('/api/v1/invites/mine').set('Authorization', BEARER);
    expect(mine.body.invites).toHaveLength(1);
    expect(mine.body.invites[0]._id).toBe(invite.body.invite._id);
  });

  it('returns 0 resolvedInvites for users with no pending email invites', async () => {
    as('clean-1', 'clean@example.com', 'Clean');
    const res = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', BEARER)
      .send({});
    expect(res.body.resolvedInvites).toBe(0);
  });

  it('is case-insensitive on email match', async () => {
    const pool = await createPool('Case Test');
    await request(app)
      .post(`/api/v1/pools/${pool._id}/invites`)
      .set('Authorization', BEARER)
      .send({ invitedEmail: 'MixedCase@Example.com' });

    as('mixed-1', 'mixedcase@example.com', 'Mixed');
    const sync = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', BEARER)
      .send({});
    expect(sync.body.resolvedInvites).toBe(1);
  });
});
