import { Router } from 'express';

export const healthzRouter: Router = Router();

healthzRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
