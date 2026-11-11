import { respond } from './agent.js';
import { pendingImages } from './db.js';
import { saveImage } from './media.js';
import { runExclusive } from './queue.js';

export type Reply = { send: (text: string) => Promise<void>; typing?: () => Promise<void> };

type Batch = { texts: string[]; paths: string[]; reply: Reply; timer?: NodeJS.Timeout };
const batches = new Map<string, Batch>();

function enqueue(chatId: string, text: string, paths: string[], reply: Reply): void {
  void runExclusive(async () => {
    try {
      await reply.typing?.().catch(() => {});
      await reply.send(await respond(chatId, text, { newImages: paths }));
    } catch (e) {
      console.error('Failed handling message:', e);
    }
  });
}

function arm(chatId: string, ms: number): void {
  const b = batches.get(chatId);
  if (!b) return;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    batches.delete(chatId);
    const text = b.texts.join('\n').trim();
    if (text) return enqueue(chatId, text, b.paths, b.reply);
    const n = pendingImages(chatId).length;
    void b.reply
      .send(`📷 Got it (${n} image${n === 1 ? '' : 's'} waiting). Tell me what to do, e.g. "post to Instagram, caption about the trip".`)
      .catch(() => {});
  }, ms);
}

/**
 * Entry point for every channel. Images and text sent in quick succession (albums, or an image followed
 * by an instruction) are batched into a single agent turn.
 */
export async function receive(
  chatId: string,
  text: string,
  images: Buffer[],
  reply: Reply,
  opts: { batch?: boolean } = {},
): Promise<void> {
  const paths: string[] = [];
  for (const buf of images) {
    try {
      paths.push(await saveImage(chatId, buf));
    } catch (e) {
      console.error('Could not process image:', e);
      void reply.send("I couldn't read that image.").catch(() => {});
    }
  }

  // Email: every message is its own turn (and gets its own reply), so skip the chat-style batching.
  if (opts.batch === false) {
    if (text || paths.length) enqueue(chatId, text, paths, reply);
    return;
  }

  let b = batches.get(chatId);
  if (paths.length) {
    b ??= { texts: [], paths: [], reply };
    batches.set(chatId, b);
    b.paths.push(...paths);
    if (text) b.texts.push(text);
    b.reply = reply;
    arm(chatId, 1500);
  } else if (b) {
    if (text) b.texts.push(text);
    b.reply = reply;
    arm(chatId, 400);
  } else if (text) {
    enqueue(chatId, text, [], reply);
  }
}
