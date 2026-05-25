process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Required by env.ts; the path itself is never read because tests mock firebase-admin.
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/pointless-test-no-such-file.json';
// Force the SendGrid send path on in tests so we can assert it's invoked for
// email-only invites. @sendgrid/mail is mocked per test file.
process.env.SENDGRID_API_KEY = 'SG.test-key';
process.env.SENDGRID_FROM_EMAIL = 'invites@pointless.test';
process.env.FRONTEND_URL = 'http://localhost:5173';
