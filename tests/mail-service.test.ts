import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendOtpEmail, sendInvitationEmail, resetMailTransporter } from '../src/shared/services/mail.service.js';

describe('Mail Service', () => {
  const originalHost = process.env.SMTP_HOST;
  const originalUser = process.env.SMTP_USER;
  const originalPass = process.env.SMTP_PASS;

  beforeEach(() => {
    process.env.SMTP_HOST = '';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    resetMailTransporter();
  });

  afterEach(() => {
    if (originalHost !== undefined) process.env.SMTP_HOST = originalHost;
    if (originalUser !== undefined) process.env.SMTP_USER = originalUser;
    if (originalPass !== undefined) process.env.SMTP_PASS = originalPass;
    resetMailTransporter();
  });

  it('gracefully handles sendOtpEmail when SMTP is not configured in non-production mode', async () => {
    const sent = await sendOtpEmail({
      to: 'test@example.com',
      code: '123456',
      role: 'STAFF',
    });

    expect(sent).toBe(false);
  });

  it('gracefully handles sendInvitationEmail when SMTP is not configured', async () => {
    const sent = await sendInvitationEmail({
      to: 'invited@example.com',
      role: 'STAFF',
      organizationName: 'Acme Corp',
      token: 'test-token-123',
    });

    expect(sent).toBe(false);
  });
});
