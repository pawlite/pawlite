import fs from 'node:fs';
import { config } from './config.js';
import { clearDraft, getDraft, imagesByIds, markImagesUsed, pendingImages, setDraft, rmImageFiles } from './db.js';
import { publishToInstagram } from './instagram.js';

const DRAFT_TTL_MS = 60 * 60 * 1000;

export function createDraft(chat: string, caption: string): { ok: boolean; text: string } {
  if (!config.igEnabled) return { ok: false, text: 'Instagram is not configured on this bot.' };
  caption = caption.trim();
  if (!caption) return { ok: false, text: 'The caption is empty.' };
  if (caption.length > 2200) return { ok: false, text: `Caption is ${caption.length} chars; Instagram allows 2200.` };
  if ((caption.match(/#\w+/g) ?? []).length > 30) return { ok: false, text: 'Instagram allows at most 30 hashtags.' };

  const imgs = pendingImages(chat, 10);
  if (!imgs.length) return { ok: false, text: 'No images are waiting. Send the image(s) first.' };

  setDraft(chat, caption, imgs.map((i) => i.id));
  return {
    ok: true,
    text: `📝 Draft Instagram post (${imgs.length} image${imgs.length > 1 ? 's' : ''}):\n\n${caption}\n\nReply /confirm to publish or /cancel to discard.`,
  };
}

export async function confirmDraft(chat: string): Promise<string> {
  const d = getDraft(chat);
  if (!d) return 'There is no draft to confirm.';
  if (Date.now() - d.ts > DRAFT_TTL_MS) {
    clearDraft(chat);
    return 'That draft expired (1 hour). Ask me to prepare it again.';
  }
  const imgs = imagesByIds(d.imageIds);
  if (!imgs.length) {
    clearDraft(chat);
    return 'The draft images are gone. Send them again.';
  }
  try {
    const r = await publishToInstagram(imgs.map((i) => i.path), d.caption);
    markImagesUsed(imgs.map((i) => i.id));
    for (const i of imgs) rmImageFiles(i.path);
    clearDraft(chat);
    return `✅ Posted to Instagram${r.permalink ? `: ${r.permalink}` : '.'}`;
  } catch (e) {
    return `❌ Instagram publish failed: ${e instanceof Error ? e.message : String(e)}\nThe draft is kept: /confirm retries, /cancel discards.`;
  }
}

export function cancelDraft(chat: string): string {
  if (!getDraft(chat)) return 'There is no draft to cancel.';
  clearDraft(chat);
  return 'Draft discarded. (The images are still saved; use /clearimages to delete them.)';
}
