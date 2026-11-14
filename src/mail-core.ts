import { config } from './config.js';
import { receive, type Reply } from './inbound.js';

export type Mail = {
  from: string; // bare, lower-case address
  subject: string;
  body: string;
  images: Buffer[];
  /** Auto-reply / bulk / mailing-list message. */
  automated: boolean;
  /** true/false if the receiving server's DKIM/DMARC verdict is known; undefined if unknown. */
  authPassed?: boolean;
};

const sentLog = new Map<string, number[]>();
const rateLimited = (addr: string): boolean => {
  const now = Date.now();
  const recent = (sentLog.get(addr) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= config.emailMaxPerHour) return true;
  recent.push(now);
  sentLog.set(addr, recent);
  return false;
};

/** Drop quoted history and signatures so the model only sees the new text. */
export function stripQuoted(text: string): string {
  const clean = (s: string): string =>
    s
      .split('\n')
      .filter((l) => !l.startsWith('>'))
      .join('\n')
      .replace(/\n-- \n[\s\S]*$/, '')
      .trim();

  const cut = text.search(/^(On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|From: .+\nSent: )/m);
  const top = clean(cut >= 0 ? text.slice(0, cut) : text);
  if (top || cut < 0) return top;

  // Bottom-posted reply: nothing above the quote header, so the answer is below it (Gmail/Apple style "On … wrote:" only;
  // Outlook-style blocks have no ">" markers, so the new text can't be told apart from the original).
  const below = text.slice(cut);
  return /^On .{5,200} wrote:/.test(below) ? clean(below.replace(/^On .{5,200} wrote:[^\n]*\n?/, '')) : '';
}

/** Parse "Name <a@b.com>", "a@b.com", {address}, or an array of those into a bare lower-case address. */
export function addrOf(x: unknown): string {
  if (Array.isArray(x)) return addrOf(x[0]);
  if (x && typeof x === 'object') return addrOf((x as Record<string, unknown>).email ?? (x as Record<string, unknown>).address);
  const m = /<([^>]+)>|([^\s<>"]+@[^\s<>"]+)/.exec(String(x ?? ''));
  return (m?.[1] ?? m?.[2] ?? '').trim().toLowerCase();
}

/** Shared gatekeeping for every email provider. `own` is this bot's own address. */
export async function dispatch(mail: Mail, own: string, reply: (text: string) => Promise<void>): Promise<void> {
  const from = mail.from;
  if (!from) return;
  if (from === own.toLowerCase()) {
    console.log(`Ignored email from ${from}: it is the bot's own address`);
    return;
  }
  if (!config.emailAllowed.includes(from)) {
    console.log(`Ignored email from ${from} (not in EMAIL_ALLOWED)`);
    return;
  }
  if (mail.automated || /(^|[._-])(no-?reply|mailer-daemon|postmaster)([._-]|@)/.test(from)) {
    console.log(`Ignored email from ${from}: automated/bulk/noreply message`);
    return;
  }
  if (config.emailRequireAuth && mail.authPassed === false) {
    console.log(`Ignored email from ${from}: DKIM/DMARC check failed (possible forged sender)`);
    return;
  }
  if (rateLimited(from)) {
    console.log(`Rate-limited email from ${from} (EMAIL_MAX_PER_HOUR)`);
    return;
  }

  const body = stripQuoted(mail.body);
  if (!body && !mail.images.length) {
    console.log(`Ignored email from ${from}: no new text after removing quoted history`);
    return;
  }
  // Keep slash-commands (/confirm, /post …) clean; otherwise give the model the subject as context.
  const text = body.startsWith('/') ? body : `[Email subject: ${mail.subject}]\n${body}`.trim();

  const r: Reply = { send: reply };
  await receive(`em:${from}`, text, mail.images, r, { batch: false });
}
