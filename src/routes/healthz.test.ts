import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

describe('GET /api/v1/healthz', () => {
  const app = createApp();

  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('echoes the x-request-id header', async () => {
    const res = await request(app).get('/api/v1/healthz').set('x-request-id', 'test-req-123');
    expect(res.headers['x-request-id']).toBe('test-req-123');
  });

  it('assigns a request id when none is supplied', async () => {
    const res = await request(app).get('/api/v1/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('404 handler', () => {
  const app = createApp();

  it('returns 404 with a structured error', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
