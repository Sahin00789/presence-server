import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

let transporter: Transporter | null = null;

export function resetMailTransporter(): void {
  transporter = null;
}

function getTransporter(): Transporter | null {
  const host = process.env.SMTP_HOST !== undefined ? process.env.SMTP_HOST : env.SMTP_HOST;
  const user = process.env.SMTP_USER !== undefined ? process.env.SMTP_USER : env.SMTP_USER;
  const pass = process.env.SMTP_PASS !== undefined ? process.env.SMTP_PASS : env.SMTP_PASS;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : env.SMTP_PORT;
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === 'true'
      : env.SMTP_SECURE;

  if (!host || !user || !pass) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: env.NODE_ENV === 'production',
      },
    });
  }

  return transporter;
}

export interface SendOtpEmailParams {
  to: string;
  code: string;
  role?: string;
  logger?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export async function sendOtpEmail(params: SendOtpEmailParams): Promise<boolean> {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    if (params.logger) {
      params.logger.warn(
        { to: params.to, code: params.code },
        '[MailService] SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS). Skipping email delivery.'
      );
    } else {
      console.warn(
        `[MailService] SMTP credentials not configured. Skipping email delivery to ${params.to} (OTP: ${params.code}).`
      );
    }

    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Mail service is not configured on production. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.'
      );
    }

    return false;
  }

  const subject = `${params.code} is your Presence verification code`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #f8fafc;
      margin: 0;
      padding: 0;
      color: #1e293b;
    }
    .container {
      max-width: 560px;
      margin: 40px auto;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
      border: 1px solid #e2e8f0;
    }
    .header {
      background-color: #0f172a;
      color: #ffffff;
      padding: 28px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header p {
      margin: 4px 0 0;
      font-size: 13px;
      color: #94a3b8;
    }
    .content {
      padding: 32px 28px;
      text-align: center;
    }
    .content h2 {
      margin: 0 0 12px;
      font-size: 18px;
      color: #0f172a;
    }
    .content p {
      margin: 0 0 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #475569;
    }
    .otp-box {
      display: inline-block;
      background-color: #f1f5f9;
      border: 2px dashed #cbd5e1;
      border-radius: 10px;
      padding: 16px 32px;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 8px;
      color: #0284c7;
      margin: 12px 0 24px;
    }
    .notice {
      background-color: #fef2f2;
      border-left: 4px solid #ef4444;
      padding: 12px 16px;
      border-radius: 4px;
      text-align: left;
      font-size: 13px;
      color: #991b1b;
      margin-top: 16px;
    }
    .footer {
      background-color: #f1f5f9;
      padding: 20px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Presence</h1>
      <p>Staff Attendance & Salary Ledger System</p>
    </div>
    <div class="content">
      <h2>Verification Code</h2>
      <p>You requested a single sign-in verification code for your account (<strong>${params.to}</strong>).</p>
      <div class="otp-box">${params.code}</div>
      <p style="font-size: 13px; color: #64748b;">This code will expire in <strong>10 minutes</strong>.</p>
      <div class="notice">
        <strong>Security Alert:</strong> Never share this code with anyone. Presence staff will never ask for your verification code.
      </div>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Presence System. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;

  const text = `Presence Verification Code: ${params.code}\n\nThis code is valid for 10 minutes. Do not share this code with anyone.`;

  try {
    const info = await mailTransporter.sendMail({
      from: env.SMTP_FROM,
      to: params.to,
      subject,
      text,
      html,
    });

    if (params.logger) {
      params.logger.info(
        { messageId: info.messageId, to: params.to },
        '[MailService] OTP verification email sent successfully'
      );
    }
    return true;
  } catch (err) {
    if (params.logger) {
      params.logger.error({ err, to: params.to }, '[MailService] Failed to send OTP email via SMTP');
    }
    throw err;
  }
}

export interface SendUserCreationEmailParams {
  to: string;
  role: string;
  organizationName: string;
  invitedByName?: string;
  logger?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export type SendInvitationEmailParams = SendUserCreationEmailParams;

export async function sendUserCreationEmail(params: SendUserCreationEmailParams): Promise<boolean> {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    if (params.logger) {
      params.logger.warn(
        { to: params.to },
        '[MailService] SMTP credentials not configured. Skipping user onboarding email.'
      );
    }
    return false;
  }

  const subject = `You've been added to ${params.organizationName} on Presence`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #f8fafc;
      margin: 0;
      padding: 0;
      color: #1e293b;
    }
    .container {
      max-width: 560px;
      margin: 40px auto;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
      border: 1px solid #e2e8f0;
    }
    .header {
      background-color: #0f172a;
      color: #ffffff;
      padding: 28px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
    }
    .content {
      padding: 32px 28px;
    }
    .role-badge {
      display: inline-block;
      background-color: #e0f2fe;
      color: #0369a1;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 13px;
    }
    .footer {
      background-color: #f1f5f9;
      padding: 20px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Presence</h1>
    </div>
    <div class="content">
      <h2>Welcome to ${params.organizationName}</h2>
      <p>Hello,</p>
      <p>You have been added to <strong>${params.organizationName}</strong> as a <span class="role-badge">${params.role}</span> on the Presence Staff & Attendance Management platform.</p>
      <p>Please open the Presence app and sign in with this email address (<strong>${params.to}</strong>) to access your workspace and start using your account.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Presence System. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;

  const text = `You've been added to ${params.organizationName} as a ${params.role} on Presence.\nSign in to the Presence app with ${params.to} to access your workspace.`;

  try {
    const info = await mailTransporter.sendMail({
      from: env.SMTP_FROM,
      to: params.to,
      subject,
      text,
      html,
    });

    if (params.logger) {
      params.logger.info(
        { messageId: info.messageId, to: params.to },
        '[MailService] User onboarding email sent successfully'
      );
    }
    return true;
  } catch (err) {
    if (params.logger) {
      params.logger.error({ err, to: params.to }, '[MailService] Failed to send user onboarding email');
    }
    return false;
  }
}

export const sendInvitationEmail = sendUserCreationEmail;
