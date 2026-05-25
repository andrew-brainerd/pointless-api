import { Router } from 'express';
import { healthzRouter } from './healthz.js';
import { usersRouter } from './users.js';
import { poolsRouter } from './pools.js';
import { invitesRouter } from './invites.js';

export const apiRouter: Router = Router();

apiRouter.use('/healthz', healthzRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/pools', poolsRouter);
apiRouter.use('/invites', invitesRouter);
