import sgMail from '@sendgrid/mail';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

let initialized = false;

const ensureInit = (): boolean => {
  if (initialized) return true;
  const env = loadEnv();
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
    return false;
  }
  sgMail.setApiKey(env.SENDGRID_API_KEY);
  initialized = true;
  return true;
};

export interface InviteEmailInput {
  toEmail: string;
  inviterName: string;
  poolName: string;
  inviteUrl: string;
}

// Sends the invite email. Returns true if sent, false if SendGrid is not
// configured (dev:local works without SendGrid). Errors propagate.
export const sendInviteEmail = async (input: InviteEmailInput): Promise<boolean> => {
  if (!ensureInit()) {
    logger.warn({ to: input.toEmail }, 'sendInviteEmail: SendGrid not configured, skipping');
    return false;
  }
  const env = loadEnv();
  const escape = (s: string): string =>
    s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  await sgMail.send({
    to: input.toEmail,
    from: env.SENDGRID_FROM_EMAIL!,
    subject: `${input.inviterName} invited you to "${input.poolName}" on Pointless`,
    text: `${input.inviterName} invited you to join the "${input.poolName}" pool on Pointless.\n\nSign in and accept here: ${input.inviteUrl}`,
    html: `<p><strong>${escape(input.inviterName)}</strong> invited you to join the <strong>${escape(input.poolName)}</strong> pool on Pointless.</p><p><a href="${escape(input.inviteUrl)}">Sign in and accept the invite</a></p>`,
  });
  return true;
};
