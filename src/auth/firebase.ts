import { initializeApp, applicationDefault, getApps, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

let app: App | undefined;

export const initFirebaseApp = (): App => {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) {
    app = existing;
    return app;
  }
  const env = loadEnv();
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Firebase Admin requires a service-account JSON path. See README "Firebase setup".',
    );
  }
  app = initializeApp({ credential: applicationDefault() });
  logger.info({ projectId: app.options.projectId }, 'firebase admin initialized');
  return app;
};

export const getFirebaseAuth = (): Auth => getAuth(initFirebaseApp());
