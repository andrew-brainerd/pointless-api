import { Router } from 'express';
import { healthzRouter } from './healthz.js';
import { usersRouter } from './users.js';
import { poolsRouter } from './pools.js';
import { invitesRouter } from './invites.js';
import { wagersRouter } from './wagers.js';
import { notificationsRouter, pusherRouter } from './notifications.js';

export const apiRouter: Router = Router();

apiRouter.use('/healthz', healthzRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/pools', poolsRouter);
apiRouter.use('/invites', invitesRouter);
apiRouter.use('/wagers', wagersRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/pusher', pusherRouter);
