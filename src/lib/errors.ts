import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const validationFailed = (details: unknown) =>
  new ApiError(422, 'validation_failed', 'Request validation failed', details);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(notFound('Route not found'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: { code: 'validation_failed', message: 'Request validation failed', details: err.issues },
    });
    return;
  }

  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err }, err.message);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message } });
};
