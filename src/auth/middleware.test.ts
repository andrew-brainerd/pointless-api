import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockVerifyIdToken } = vi.hoisted(() => ({ mockVerifyIdToken: vi.fn() }));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ options: { projectId: 'test-project' } })),
  applicationDefault: vi.fn(),
  getApps: vi.fn(() => []),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

const { requireAuth } = await import('./middleware.js');

interface MockReq {
  header: (name: string) => string | undefined;
  user?: { uid: string; email: string; name: string };
}

const buildReq = (headers: Record<string, string>): MockReq => ({
  header: (name: string) => headers[name.toLowerCase()],
});

describe('requireAuth', () => {
  let next: ReturnType<typeof vi.fn>;
  const res = {} as Response;

  beforeEach(() => {
    next = vi.fn();
    mockVerifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with 401 when no Authorization header is present', async () => {
    const req = buildReq({});
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, code: 'unauthorized' }),
    );
  });

  it('rejects with 401 when Authorization is not a Bearer scheme', async () => {
    const req = buildReq({ authorization: 'Basic abc' });
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('rejects with 401 when bearer token is empty', async () => {
    const req = buildReq({ authorization: 'Bearer ' });
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('rejects with 401 when verifyIdToken throws', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('expired'));
    const req = buildReq({ authorization: 'Bearer bad-token' });
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, message: 'Invalid or expired token' }),
    );
  });

  it('rejects with 401 when decoded token has no email claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'u1' });
    const req = buildReq({ authorization: 'Bearer ok' });
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, message: 'Token has no email claim' }),
    );
  });

  it('attaches req.user and calls next() with no error on a valid token', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: 'uid-123',
      email: 'alice@example.com',
      name: 'Alice',
    });
    const req = buildReq({ authorization: 'Bearer good-token' });
    await requireAuth(req as unknown as Request, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ uid: 'uid-123', email: 'alice@example.com', name: 'Alice' });
  });

  it('falls back to email when token has no name claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'u', email: 'bob@example.com' });
    const req = buildReq({ authorization: 'Bearer good' });
    await requireAuth(req as unknown as Request, res, next);
    expect(req.user?.name).toBe('bob@example.com');
  });
});
