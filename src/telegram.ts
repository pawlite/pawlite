import { config } from './config.js';
import { receive } from './inbound.js';

type TgPhoto = { file_id: string };
type TgMessage = {
  message_id: number;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: { file_id: string; mime_type?: string };
  media_group_id?: string;
};
type TgUpdate = { update_id: number; message?: TgMessage };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const chunk = (s: string, n = 4000): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
};

async function call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result;
}

async function downloadFile(fileId: string): Promise<Buffer> {
  const f = await call<{ file_path: string }>('getFile', { file_id: fileId });
  const res = await fetch(`${config.telegramApiBase}/file/bot${config.telegramToken}/${f.file_path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function startTelegram(): Promise<void> {
  if (!config.telegramToken) return;
  const me = await call<{ username: string }>('getMe');
  const mention = new RegExp(`@${me.username}\\b`, 'i');
  const albumsAddressedToUs = new Set<string>();
  console.log(`Telegram: polling as @${me.username}`);

  async function handle(m: TgMessage): Promise<void> {
    if (!m.from || m.from.is_bot) return;
    const fromId = String(m.from.id);
    if (!config.telegramAllowed.includes(fromId)) {
      console.log(`Ignored Telegram message from user id ${fromId} (not in ALLOWED_TELEGRAM_IDS)`);
      return;
    }

    let text = (m.text ?? m.caption ?? '').trim();
    const isGroup = m.chat.type !== 'private';
    if (isGroup) {
      const inKnownAlbum = m.media_group_id ? albumsAddressedToUs.has(m.media_group_id) : false;
      if (!mention.test(text) && !inKnownAlbum) return; // groups: only when addressed
      if (m.media_group_id) albumsAddressedToUs.add(m.media_group_id);
      text = text.replace(mention, '').trim();
    }

    const images: Buffer[] = [];
    const fileId = m.photo?.at(-1)?.file_id ?? (m.document?.mime_type?.startsWith('image/') ? m.document.file_id : undefined);
    if (fileId) {
      try {
        images.push(await downloadFile(fileId));
      } catch (e) {
        console.error('Telegram image download failed:', e);
      }
    }
    if (!text && !images.length) return;

    await receive(`tg:${m.chat.id}`, text, images, {
      send: async (t) => {
        for (const part of chunk(t)) await call('sendMessage', { chat_id: m.chat.id, text: part });
      },
      typing: () => call('sendChatAction', { chat_id: m.chat.id, action: 'typing' }).then(() => {}),
    });
  }

  let offset = 0;
  void (async () => {
    for (;;) {
      try {
        const updates = await call<TgUpdate[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 70_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) void handle(u.message).catch((e) => console.error('Telegram handler error:', e));
        }
      } catch (e) {
        console.error('Telegram polling error:', e instanceof Error ? e.message : e);
        await sleep(5000);
      }
    }
  })();
}
