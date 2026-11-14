import { config } from './config.js';
import fs from 'node:fs';
import { clearMailDraft, getMailDraft, imagesByIds, mailCopyPath, pendingImages, setMailDraft } from './db.js';

export type MailAttachment = { filename: string; path: string };
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // Gmail's limit is 25 MB including encoding overhead

const DRAFT_TTL_MS = 60 * 60 * 1000;
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Which mailbox new mail goes out from, or undefined if none is configured. */
function sender(): { via: 'imap' | 'agentmail'; address: string } | undefined {
  const imap = config.imapEnabled ? ({ via: 'imap', address: config.imapUser } as const) : undefined;
  const am = config.agentmailEnabled ? ({ via: 'agentmail', address: config.agentmailInbox } as const) : undefined;
  if (config.emailSendVia === 'agentmail') return am ?? imap;
  if (config.emailSendVia === 'imap') return imap ?? am;
  return imap ?? am;
}

export const canSendEmail = (): boolean => sender() !== undefined;

const lastSent = new Map<string, { to: string; subject: string; at: number }>();
const sentLog: number[] = [];
const overLimit = (): boolean => {
  const now = Date.now();
  while (sentLog.length && now - sentLog[0] > 3600_000) sentLog.shift();
  return sentLog.length >= config.emailMaxPerHour;
};

/** Validate and store a draft. Nothing is sent until the user runs /send. */
export function createMailDraft(chat: string, toRaw: string, subjectRaw: string, bodyRaw: string, attachImages = false): { ok: boolean; text: string } {
  const from = sender();
  if (!from) return { ok: false, text: 'No mailbox is configured, so I cannot send email.' };
  const to = toRaw.trim().toLowerCase();
  const subject = subjectRaw.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '(no subject)';
  const body = bodyRaw.trim();
  if (!ADDRESS.test(to)) return { ok: false, text: `"${toRaw}" is not a valid single email address.` };
  if (to === from.address.toLowerCase()) return { ok: false, text: 'That is my own address.' };
  if (!config.emailSendAny && !config.emailAllowed.includes(to))
    return { ok: false, text: `${to} is not in EMAIL_ALLOWED. Add it there (or set EMAIL_SEND_ANY=true) to let me email it.` };
  if (!body) return { ok: false, text: 'The email body is empty.' };
  if (body.length > 5000) return { ok: false, text: `The body is ${body.length} chars; the limit is 5000.` };

  const imageIds = attachImages ? pendingImages(chat, 10).map((i) => i.id) : [];
  if (attachImages && !imageIds.length) return { ok: false, text: 'No images are waiting in this chat. Ask the user to send the images first.' };

  setMailDraft(chat, to, subject, body, imageIds);
  return {
    ok: true,
    text: `✉️ Draft email from ${from.address}\nTo: ${to}\nSubject: ${subject}${imageIds.length ? `\nAttachments: ${imageIds.length} image(s)` : ''}\n\n${body}\n\nTell me to send it, or reply /send. /cancel discards it.`,
  };
}

export async function sendMailDraft(chat: string): Promise<{ ok: boolean; text: string }> {
  const d = getMailDraft(chat);
  if (!d) {
    const ls = lastSent.get(chat);
    if (ls && Date.now() - ls.at < 24 * 3600_000)
      return {
        ok: false,
        text: `Nothing to send: no draft is pending. The email to ${ls.to} ("${ls.subject}") was already sent at ${new Date(ls.at).toLocaleTimeString()}; check the Sent folder.`,
      };
    return { ok: false, text: 'There is no email draft to send.' };
  }
  if (Date.now() - d.ts > DRAFT_TTL_MS) {
    clearMailDraft(chat);
    return { ok: false, text: 'That draft expired (1 hour). Ask me to write it again.' };
  }
  const from = sender();
  if (!from) return { ok: false, text: 'No mailbox is configured.' };
  const files: MailAttachment[] = [];
  const rows = imagesByIds(d.imageIds);
  if (rows.length < d.imageIds.length) return { ok: false, text: 'Some attached images were deleted (/clearimages or cleanup). Ask me to write the email again.' };
  let total = 0;
  rows.forEach((r, n) => {
    const p = fs.existsSync(mailCopyPath(r.path)) ? mailCopyPath(r.path) : r.path;
    total += fs.existsSync(p) ? fs.statSync(p).size : 0;
    files.push({ filename: `image-${n + 1}.jpg`, path: p });
  });
  if (files.some((f) => !fs.existsSync(f.path))) return { ok: false, text: 'An attached image file is missing. Ask me to write the email again.' };
  if (total > MAX_ATTACH_BYTES) return { ok: false, text: `Attachments total ${(total / 1048576).toFixed(1)} MB; the limit is 20 MB. Attach fewer images.` };
  if (overLimit()) return { ok: false, text: `Hourly email limit reached (EMAIL_MAX_PER_HOUR=${config.emailMaxPerHour}). Try later; the draft is kept.` };
  try {
    // Imported lazily to avoid an import cycle (mail provider -> mail-core -> agent -> tools -> here).
    if (from.via === 'imap') await (await import('./email-imap.js')).sendViaImap(d.to, d.subject, d.body, files);
    else await (await import('./email-agentmail.js')).sendViaAgentMail(d.to, d.subject, d.body, files);
    sentLog.push(Date.now());
    lastSent.set(chat, { to: d.to, subject: d.subject, at: Date.now() });
    clearMailDraft(chat);
    return { ok: true, text: `✅ Email sent to ${d.to}.` };
  } catch (e) {
    return { ok: false, text: `❌ Sending failed: ${e instanceof Error ? e.message : String(e)}\nThe draft is kept: /send retries, /cancel discards.` };
  }
}

export function cancelMailDraft(chat: string): boolean {
  if (!getMailDraft(chat)) return false;
  clearMailDraft(chat);
  return true;
}

/**
 * Decide from the USER's words (not the model's tool choice) whether an email should be sent now or saved as a draft.
 * Default is to send; drafting happens only when the user clearly asks for a draft / to review first.
 */
export function emailIntent(userText: string): 'send' | 'draft' {
  const t = userText.replace(/^\[Email subject:[^\n]*\]\n?/, '').toLowerCase();
  if (/\b(don'?t|do not|dont|no need to|without)\s+(to\s+)?send/.test(t)) return 'draft';
  if (/\bbefore\s+(you\s+)?send/.test(t) || /\b(show|let)\s+me\s+(see|review|check|read|approve)\b/.test(t)) return 'draft';
  if (/\b(send|sent)\b/.test(t)) return 'send';
  if (/\b(draft|compose|write|prepare|preview)\b/.test(t)) return 'draft';
  return 'send';
}

/** "send it", "ok send", "go ahead and send the draft" ... */
export const isSendConfirmation = (userText: string): boolean =>
  /^(?:(?:go ahead(?: and)?|yes|yeah|yep|ok|okay|sure|please)[\s,.!]*)*send(?: it| that| this| the (?:email|draft|mail|message))?(?: now| please)?[\s.!]*$/i.test(userText.trim());
