import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";

import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

/**
 * Transactional email through AWS SES.
 *
 * The client is constructed once, at module load, with credentials read explicitly from the
 * environment (see config/env.ts). The alternative — letting the SDK walk the default credential
 * chain — silently works on a laptop with `~/.aws/credentials` and then fails in a container that
 * has neither a profile nor an instance role. Passing the keys in means the same code path runs
 * everywhere, and a missing key is a boot-time error, not a first-send surprise.
 */
const ses = new SESClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

// RFC 5322 display-name form: `Vellum <noreply@paperflow.in>`. The name is what a human sees in
// their inbox; the address is what SES must have verified.
const FROM = `${env.AWS_SES_FROM_NAME} <${env.AWS_SES_FROM_EMAIL}>`;

// Whether SES is actually configured. Outside production the keys may be absent (see config/env.ts),
// in which case there is nothing to send *to* — attempting it just fails a network call and logs
// noise. Skip cleanly and record it, so a developer testing sign-up sees why no mail arrived.
const sesConfigured = env.AWS_ACCESS_KEY_ID !== "" && env.AWS_SES_FROM_EMAIL !== "";

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  if (!sesConfigured) {
    logger.warn({ to, subject }, "SES not configured — email skipped (set AWS_* to enable)");
    return;
  }

  try {
    await ses.send(
      new SendEmailCommand({
        Source: FROM,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            // Always send both parts. A text/plain alternative is what renders in a watch, a screen
            // reader, and a client that refuses remote HTML — and it is the part that does not land
            // a transactional email in spam for looking like marketing.
            Html: { Data: html, Charset: "UTF-8" },
            Text: { Data: text, Charset: "UTF-8" },
          },
        },
      }),
    );
  } catch (cause) {
    // Log the SES failure with the recipient for support, but re-throw a generic error: the caller
    // turns email trouble into a vague "could not send" so a reset/verify endpoint never becomes an
    // oracle for which addresses SES accepts.
    logger.error({ err: cause, to }, "SES send failed");
    throw new Error("email delivery failed", { cause });
  }
}

const BASE_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;line-height:1.5";
const CODE_STYLE =
  "display:inline-block;font-size:28px;font-weight:600;letter-spacing:6px;padding:12px 20px;background:#f4f4f5;border-radius:8px;margin:16px 0";
const BUTTON_STYLE =
  "display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;margin:20px 0";

/**
 * HTML-escape an untrusted value before interpolating it into an email body.
 *
 * A document title and a display name are user input. Dropped raw into HTML they are a mail-injection
 * vector — a title of `<a href="http://evil">` would render as a live link in the recipient's inbox.
 * The token link is server-built (safe), but everything the inviter typed is escaped here.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sign-up: confirm the address is real and reachable. */
export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  const subject = "Verify your email";
  const html = `<div style="${BASE_STYLE}">
  <h2 style="margin:0 0 8px">Confirm your email</h2>
  <p>Enter this code to finish setting up your ${env.AWS_SES_FROM_NAME} account:</p>
  <div style="${CODE_STYLE}">${code}</div>
  <p style="color:#666;font-size:14px">This code expires in 10 minutes. If you didn't create an account, you can ignore this email.</p>
</div>`;
  const text = `Confirm your email\n\nYour ${env.AWS_SES_FROM_NAME} verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't create an account, you can ignore this email.`;

  await sendEmail(to, subject, html, text);
}

/**
 * Collaboration invite: tell someone a document has been shared with them, and link them to accept.
 *
 * The link carries the capability token. The email is addressed to the invited address, and accepting
 * additionally requires signing in as that address — so forwarding the mail does not hand the document
 * to someone else. Everything the inviter controls (their name, the document title) is HTML-escaped.
 */
export async function sendInvitationEmail(
  to: string,
  options: {
    inviterName: string;
    documentTitle: string;
    role: "EDITOR" | "VIEWER";
    acceptUrl: string;
    expiresInDays: number;
  },
): Promise<void> {
  const inviter = escapeHtml(options.inviterName);
  const title = escapeHtml(options.documentTitle);
  const capability = options.role === "EDITOR" ? "edit" : "view";
  const subject = `${options.inviterName} shared "${options.documentTitle}" with you`;

  const html = `<div style="${BASE_STYLE}">
  <h2 style="margin:0 0 8px">You've been invited to collaborate</h2>
  <p><strong>${inviter}</strong> invited you to <strong>${capability}</strong> the document <strong>"${title}"</strong> on ${env.AWS_SES_FROM_NAME}.</p>
  <a href="${options.acceptUrl}" style="${BUTTON_STYLE}">View invitation</a>
  <p style="color:#666;font-size:14px">Or paste this link into your browser:<br><span style="color:#111">${options.acceptUrl}</span></p>
  <p style="color:#666;font-size:14px">This invitation expires in ${String(options.expiresInDays)} days. To accept, sign in with <strong>${escapeHtml(to)}</strong>. If you weren't expecting this, you can ignore this email.</p>
</div>`;

  const text = `${options.inviterName} invited you to ${capability} "${options.documentTitle}" on ${env.AWS_SES_FROM_NAME}.

Accept the invitation:
${options.acceptUrl}

This invitation expires in ${String(options.expiresInDays)} days. To accept, sign in with ${to}. If you weren't expecting this, you can ignore this email.`;

  await sendEmail(to, subject, html, text);
}

/** Forgot password: authorise a password change the requester initiated. */
export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  const subject = "Reset your password";
  const html = `<div style="${BASE_STYLE}">
  <h2 style="margin:0 0 8px">Reset your password</h2>
  <p>Enter this code to choose a new password:</p>
  <div style="${CODE_STYLE}">${code}</div>
  <p style="color:#666;font-size:14px">This code expires in 10 minutes. If you didn't request a password reset, ignore this email — your password will not change.</p>
</div>`;
  const text = `Reset your password\n\nYour ${env.AWS_SES_FROM_NAME} password reset code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request a password reset, ignore this email — your password will not change.`;

  await sendEmail(to, subject, html, text);
}
