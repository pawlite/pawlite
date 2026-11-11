import fs from 'node:fs';
import type { MailAttachment } from './send-mail.js';
import { config } from './config.js';
import { markSeen } from './db.js';
import { addrOf, dispatch } from './mail-core.js';

type Json = Record<string, any>;

async function api(method: string, route: string, opts: { body?: Json; query?: Record<string, string> } = {}): Promise<Json> {
  const url = new URL(`${config.agentmailBase}${route}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.append(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.agentmailKey}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`AgentMail ${method} ${route} → ${res.status}: ${data?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Attachments may come back as raw bytes or as JSON pointing at a download URL; handle both. */
async function downloadAttachment(route: string): Promise<Buffer> {
  const res = await fetch(`${config.agentmailBase}${route}`, {
    headers: { Authorization: `Bearer ${config.agentmailKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const j = (await res.json()) as Json;
    const url = (j.download_url ?? j.url) as string | undefined;
    if (!url) throw new Error('attachment response had no download_url');
    const file = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok) throw new Error(`attachment download ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Send a brand-new message from the AgentMail inbox. */
export async function sendViaAgentMail(to: string, subject: string, text: string, files: MailAttachment[] = []): Promise<void> {
  const attachments = files.map((f) => ({ filename: f.filename, content_type: 'image/jpeg', content: fs.readFileSync(f.path).toString('base64') }));
  await api('POST', `/inboxes/${encodeURIComponent(config.agentmailInbox)}/messages/send`, {
    body: { to: [to], subject, text, ...(attachments.length ? { attachments } : {}) },
  });
}

export async function pollAgentMail(): Promise<void> {
  const inbox = encodeURIComponent(config.agentmailInbox);
  const list = await api('GET', `/inboxes/${inbox}/messages`, { query: { labels: 'unread', limit: '20' } });

  for (const item of (list.messages ?? []) as Json[]) {
    const id = String(item.message_id ?? '');
    if (!id || ((item.labels ?? []) as string[]).includes('sent')) continue;
    if (!markSeen(`agentmail:${id}`)) continue; // already handled (e.g. label update failed last time)

    const mid = encodeURIComponent(id);
    const msg = await api('GET', `/inboxes/${inbox}/messages/${mid}`);
    await api('PATCH', `/inboxes/${inbox}/messages/${mid}`, { body: { add_labels: ['processed'], remove_labels: ['unread'] } }).catch(
      (e) => console.error('AgentMail: could not mark message read:', e instanceof Error ? e.message : e),
    );

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((msg.headers ?? {}) as Json)) headers[k.toLowerCase()] = String(v).toLowerCase();
    const automated =
      (headers['auto-submitted'] ?? 'no') !== 'no' || /bulk|junk|list/.test(headers['precedence'] ?? '') || 'list-id' in headers;

    const images: Buffer[] = [];
    for (const a of ((msg.attachments ?? []) as Json[]).slice(0, 10)) {
      if (!String(a.content_type ?? '').startsWith('image/')) continue;
      try {
        images.push(await downloadAttachment(`/inboxes/${inbox}/messages/${mid}/attachments/${encodeURIComponent(String(a.attachment_id))}`));
      } catch (e) {
        console.error('AgentMail attachment failed:', e instanceof Error ? e.message : e);
      }
    }

    await dispatch(
      {
        from: addrOf(msg.from ?? msg.from_ ?? item.from),
        subject: String(msg.subject ?? item.subject ?? '(no subject)'),
        body: String(msg.extracted_text ?? msg.text ?? ''),
        images,
        automated,
        // AgentMail doesn't expose a DKIM/DMARC verdict I can rely on, so sender checks rely on EMAIL_ALLOWED only.
        authPassed: undefined,
      },
      config.agentmailInbox,
      async (text) => {
        await api('POST', `/inboxes/${inbox}/messages/${mid}/reply`, { body: { text } });
      },
    ).catch((e) => console.error('AgentMail processing error:', e));
  }
}
