import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailAttachment } from './send-mail.js';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { markSeen } from './db.js';
import { dispatch } from './mail-core.js';

const MAX_PER_POLL = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const transporter = (): Transporter =>
  nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.imapUser, pass: config.imapPassword },
  });

/** Send a brand-new message from the Gmail/IMAP mailbox. */
export async function sendViaImap(to: string, subject: string, text: string, files: MailAttachment[] = []): Promise<void> {
  await transporter().sendMail({ from: config.imapUser, to, subject, text, attachments: files.map((f) => ({ filename: f.filename, path: f.path })) });
}

/** Parse one raw RFC822 message and hand it to the shared dispatcher. */
export async function processRaw(source: Buffer): Promise<void> {
  const p = await simpleParser(source);
  const from = p.from?.value[0]?.address?.toLowerCase();
  if (!from) return;

  const messageId = p.messageId ?? `${from}|${p.date?.toISOString()}|${p.subject}`;
  if (!markSeen(`imap:${messageId}`)) return;

  // The receiving server's verdict (top-most Authentication-Results header), if any.
  const authLine = p.headerLines.find((h) => h.key === 'authentication-results')?.line ?? '';
  const authPassed = authLine ? /dmarc=pass/i.test(authLine) || /dkim=pass/i.test(authLine) : undefined;

  const header = (k: string): string => String(p.headers.get(k) ?? '').toLowerCase();
  const automated =
    (header('auto-submitted') !== '' && header('auto-submitted') !== 'no') ||
    /bulk|junk|list/.test(header('precedence')) ||
    p.headers.has('list-id');

  const images = p.attachments
    .filter((a) => a.contentType.startsWith('image/') && a.size <= MAX_IMAGE_BYTES)
    .slice(0, 10)
    .map((a) => a.content);

  const subject = p.subject ?? '(no subject)';
  const refs = [...(Array.isArray(p.references) ? p.references : p.references ? [p.references] : []), messageId];

  await dispatch(
    { from, subject, body: p.text ?? '', images, automated, authPassed },
    config.imapUser,
    async (text) => {
      await transporter().sendMail({
        from: config.imapUser,
        to: from,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        text,
        inReplyTo: messageId,
        references: refs,
      });
    },
  );
}

/** One short-lived IMAP session: fetch unread mail, mark it read, then process it. */
export async function pollImap(): Promise<void> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.imapUser, pass: config.imapPassword },
    logger: config.imapErrorLogger,
  });
  client.on('error', () => {});
  await client.connect();

  const raws: Buffer[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids.slice(0, MAX_PER_POLL)) {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (m && m.source) raws.push(m.source);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
  }
  await client.logout().catch(() => {});

  for (const raw of raws) {
    await processRaw(raw).catch((e) => console.error('Email processing error:', e));
  }
}
