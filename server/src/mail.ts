import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { getPublicUrl } from './config.js'

/**
 * Email sending — plain SMTP, configured entirely by env vars.
 * Works with any SMTP endpoint (Resend, Postmark, SES, Mailgun, self-hosted).
 *
 *   SMTP_HOST      smtp.resend.com          (unset = email sending disabled)
 *   SMTP_PORT      587 (default) | 465 (implicit TLS) | 25
 *   SMTP_USER      username / api key id
 *   SMTP_PASS      password / api key
 *   SMTP_FROM      "MyApp <no-reply@myapp.com>"  (default: no-reply@<EZBASE_URL host>)
 *
 * When SMTP is not configured, callers should fall back to logging links so
 * self-hosters can still complete flows from server logs.
 */

let transport: Transporter | null = null

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST)
}

function getTransport(): Transporter {
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10)
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  }
  return transport
}

function defaultFrom(): string {
  const { origin } = getPublicUrl()
  return `ezbase <no-reply@${new URL(origin).hostname}>`
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  if (!isMailConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST)')
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || defaultFrom(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  })
}
