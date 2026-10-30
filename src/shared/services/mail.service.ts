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

export interface SendOrganizationWelcomeEmailParams {
  to: string;
  ownerName: string;
  organizationName: string;
  premisesName?: string;
  premisesAddress?: string;
  radiusMeters?: number;
  logger?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export async function sendOrganizationWelcomeEmail(params: SendOrganizationWelcomeEmailParams): Promise<boolean> {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    if (params.logger) {
      params.logger.warn(
        { to: params.to },
        '[MailService] SMTP credentials not configured. Skipping organization welcome email.'
      );
    }
    return false;
  }

  const subject = `Welcome to Presence! ${params.organizationName} workspace created`;

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
      max-width: 580px;
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
      padding: 32px 28px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .content {
      padding: 32px 28px;
    }
    .card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 18px 20px;
      margin: 20px 0;
    }
    .card-item {
      margin-bottom: 8px;
      font-size: 14px;
    }
    .card-item:last-child {
      margin-bottom: 0;
    }
    .steps {
      margin-top: 24px;
    }
    .step-item {
      margin-bottom: 12px;
      font-size: 14px;
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
      <h2>Welcome, ${params.ownerName}! 🎉</h2>
      <p>Your business workspace <strong>${params.organizationName}</strong> has been successfully created on Presence.</p>

      ${params.premisesName ? `
      <div class="card">
        <div class="card-item"><strong>Primary Premises:</strong> ${params.premisesName}</div>
        ${params.premisesAddress ? `<div class="card-item"><strong>Address:</strong> ${params.premisesAddress}</div>` : ''}
        <div class="card-item"><strong>GPS Geofence Radius:</strong> ${params.radiusMeters ?? 50} metres</div>
      </div>
      ` : ''}

      <div class="steps">
        <h3>Next steps to get started:</h3>
        <div class="step-item">1. <strong>Add Managers:</strong> Assign managers to handle daily premises operations and staff.</div>
        <div class="step-item">2. <strong>Enroll Staff:</strong> Perform face verification enrollment for your premises staff.</div>
        <div class="step-item">3. <strong>Configure Shifts:</strong> Set up shift schedules, pay rates, and automated attendance rules.</div>
      </div>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Presence Staff & Attendance Management. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;

  const text = `Welcome to Presence, ${params.ownerName}!\n\nYour workspace ${params.organizationName} has been created successfully.${params.premisesName ? `\nPrimary Premises: ${params.premisesName}` : ''}\n\nSign in to the Presence app to start managing staff, shifts, and attendance.`;

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
        '[MailService] Organization welcome email sent successfully'
      );
    }
    return true;
  } catch (err) {
    if (params.logger) {
      params.logger.error({ err, to: params.to }, '[MailService] Failed to send organization welcome email');
    }
    return false;
  }
}

export interface SendMonthlyReportEmailParams {
  to: string;
  recipientName: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  organizationName: string;
  month: number;
  year: number;
  pdfBuffer?: Buffer;
  csvContent?: string;
  logger?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export async function sendMonthlyReportEmail(params: SendMonthlyReportEmailParams): Promise<boolean> {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    if (params.logger) {
      params.logger.warn(
        { to: params.to },
        '[MailService] SMTP credentials not configured. Skipping monthly report email.'
      );
    }
    return false;
  }

  const monthName = new Date(params.year, params.month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const subject = `Monthly ${params.role} Summary Report - ${monthName} ${params.year} (${params.organizationName})`;

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
      max-width: 580px;
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
      padding: 28px;
    }
    .badge {
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
      padding: 16px;
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
      <h1>Presence Reports</h1>
    </div>
    <div class="content">
      <h2>Hello, ${params.recipientName} 👋</h2>
      <p>Your monthly <strong>${params.role}</strong> summary report for <strong>${monthName} ${params.year}</strong> is attached to this email.</p>
      <p><strong>Organization:</strong> ${params.organizationName}</p>
      <p>The report includes complete attendance, shift, and payroll statements in PDF and Excel (CSV) formats.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Presence Staff & Attendance Management. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;

  const attachments: Array<{ filename: string; content: Buffer | string; contentType: string }> = [];
  const fileStamp = `${params.year}-${String(params.month).padStart(2, '0')}`;

  if (params.pdfBuffer) {
    attachments.push({
      filename: `Monthly-Report-${params.role}-${fileStamp}.pdf`,
      content: params.pdfBuffer,
      contentType: 'application/pdf',
    });
  }

  if (params.csvContent) {
    attachments.push({
      filename: `Monthly-Report-${params.role}-${fileStamp}.csv`,
      content: params.csvContent,
      contentType: 'text/csv; charset=utf-8',
    });
  }

  try {
    const info = await mailTransporter.sendMail({
      from: env.SMTP_FROM,
      to: params.to,
      subject,
      text: `Hello ${params.recipientName},\n\nYour monthly ${params.role} summary report for ${monthName} ${params.year} at ${params.organizationName} is attached in PDF and Excel formats.`,
      html,
      attachments,
    });

    if (params.logger) {
      params.logger.info(
        { messageId: info.messageId, to: params.to, role: params.role },
        '[MailService] Monthly report email sent successfully'
      );
    }
    return true;
  } catch (err) {
    if (params.logger) {
      params.logger.error({ err, to: params.to }, '[MailService] Failed to send monthly report email');
    }
    return false;
  }
}
