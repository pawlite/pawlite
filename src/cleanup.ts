import fs from 'node:fs';
import { clearDraft, deleteImages, pendingImages, rmImageFiles } from './db.js';

/** Delete a chat's unposted images (files + rows) and any draft that references them. */
export function clearPendingImages(chat: string): number {
  const imgs = pendingImages(chat, 1000);
  for (const i of imgs) rmImageFiles(i.path);
  deleteImages(imgs.map((i) => i.id));
  clearDraft(chat);
  return imgs.length;
}
