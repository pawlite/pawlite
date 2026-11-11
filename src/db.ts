import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'pawlite.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat, id);

  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat TEXT NOT NULL, path TEXT NOT NULL, ts INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_images_chat ON images(chat, used, id);

  CREATE TABLE IF NOT EXISTS summaries (
    chat TEXT PRIMARY KEY, summary TEXT NOT NULL, upto_id INTEGER NOT NULL, ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seen_mail (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS drafts (
    chat TEXT PRIMARY KEY, caption TEXT NOT NULL, image_ids TEXT NOT NULL, ts INTEGER NOT NULL
  );
`);

// ---- messages ----
export type Row = { role: 'user' | 'assistant'; content: string };
const insertMsg = db.prepare('INSERT INTO messages (chat, role, content, ts) VALUES (?, ?, ?, ?)');
// Messages already folded into a summary (id <= upto_id) are no longer sent verbatim.
const selectMsgs = db.prepare(
  'SELECT role, content FROM messages WHERE chat = ? AND id > COALESCE((SELECT upto_id FROM summaries WHERE chat = ?), 0) ORDER BY id DESC LIMIT ?',
);
const wipeMsgs = db.prepare('DELETE FROM messages WHERE chat = ?');
export const addMessage = (chat: string, role: Row['role'], content: string): void => {
  insertMsg.run(chat, role, content, Date.now());
};
/** Oldest-first list of the last `limit` messages. */
export const recent = (chat: string, limit: number): Row[] => (selectMsgs.all(chat, chat, limit) as Row[]).reverse();
const wipeSummary = db.prepare('DELETE FROM summaries WHERE chat = ?');
export const clearChat = (chat: string): void => {
  wipeMsgs.run(chat);
  wipeSummary.run(chat);
};

// ---- compaction support ----
const selectLive = db.prepare(
  'SELECT id, role, content FROM messages WHERE chat = ? AND id > COALESCE((SELECT upto_id FROM summaries WHERE chat = ?), 0) ORDER BY id ASC',
);
const selectSummary = db.prepare('SELECT summary, upto_id FROM summaries WHERE chat = ?');
const upsertSummary = db.prepare(
  'INSERT INTO summaries (chat, summary, upto_id, ts) VALUES (?, ?, ?, ?) ON CONFLICT(chat) DO UPDATE SET summary=excluded.summary, upto_id=excluded.upto_id, ts=excluded.ts',
);
const selectChats = db.prepare('SELECT DISTINCT chat FROM messages');
export type LiveRow = { id: number; role: 'user' | 'assistant'; content: string };
export const liveMessages = (chat: string): LiveRow[] => selectLive.all(chat, chat) as LiveRow[];
export const getSummary = (chat: string): { summary: string; uptoId: number } | undefined => {
  const r = selectSummary.get(chat) as { summary: string; upto_id: number } | undefined;
  return r ? { summary: r.summary, uptoId: r.upto_id } : undefined;
};
export const setSummary = (chat: string, summary: string, uptoId: number): void => {
  upsertSummary.run(chat, summary, uptoId, Date.now());
};
export const allChats = (): string[] => (selectChats.all() as { chat: string }[]).map((r) => r.chat);

// ---- images ----
export type ImageRow = { id: number; path: string };
const insertImg = db.prepare('INSERT INTO images (chat, path, ts) VALUES (?, ?, ?)');
const selectPending = db.prepare('SELECT id, path FROM images WHERE chat = ? AND used = 0 ORDER BY id DESC LIMIT ?');
const markUsed = db.prepare('UPDATE images SET used = 1 WHERE id = ?');
const selectStale = db.prepare('SELECT id, path FROM images WHERE ts < ?');
const deleteImg = db.prepare('DELETE FROM images WHERE id = ?');

export const addImage = (chat: string, p: string): void => {
  insertImg.run(chat, p, Date.now());
};
/** The newest `limit` unused images, oldest-first (Instagram carousels max out at 10). */
export const pendingImages = (chat: string, limit = 10): ImageRow[] =>
  (selectPending.all(chat, limit) as ImageRow[]).reverse();
export const imagesByIds = (ids: number[]): ImageRow[] => {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT id, path FROM images WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as ImageRow[];
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is ImageRow => Boolean(r));
};
export const markImagesUsed = (ids: number[]): void => {
  for (const id of ids) markUsed.run(id);
};
export const staleImages = (cutoffTs: number): ImageRow[] => selectStale.all(cutoffTs) as ImageRow[];
export const deleteImages = (ids: number[]): void => {
  for (const id of ids) deleteImg.run(id);
};

// ---- drafts (pending Instagram posts awaiting /confirm) ----
export type Draft = { caption: string; imageIds: number[]; ts: number };
const upsertDraft = db.prepare(
  'INSERT INTO drafts (chat, caption, image_ids, ts) VALUES (?, ?, ?, ?) ON CONFLICT(chat) DO UPDATE SET caption=excluded.caption, image_ids=excluded.image_ids, ts=excluded.ts',
);
const selectDraft = db.prepare('SELECT caption, image_ids, ts FROM drafts WHERE chat = ?');
const deleteDraft = db.prepare('DELETE FROM drafts WHERE chat = ?');
export const setDraft = (chat: string, caption: string, imageIds: number[]): void => {
  upsertDraft.run(chat, caption, JSON.stringify(imageIds), Date.now());
};
export const getDraft = (chat: string): Draft | undefined => {
  const r = selectDraft.get(chat) as { caption: string; image_ids: string; ts: number } | undefined;
  return r ? { caption: r.caption, imageIds: JSON.parse(r.image_ids) as number[], ts: r.ts } : undefined;
};
export const clearDraft = (chat: string): void => {
  deleteDraft.run(chat);
};

// ---- email de-duplication ----
const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_mail (key, ts) VALUES (?, ?)');
const pruneSeenStmt = db.prepare('DELETE FROM seen_mail WHERE ts < ?');
/** Returns true the first time a key is seen, false afterwards. */
export const markSeen = (key: string): boolean => insertSeen.run(key, Date.now()).changes === 1;
export const pruneSeen = (maxAgeMs = 30 * 24 * 3600 * 1000): void => {
  pruneSeenStmt.run(Date.now() - maxAgeMs);
};

// ---- mail drafts (pending outgoing emails awaiting /send) ----
db.exec('CREATE TABLE IF NOT EXISTS mail_drafts (chat TEXT PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL)');
try {
  db.exec("ALTER TABLE mail_drafts ADD COLUMN image_ids TEXT NOT NULL DEFAULT '[]'"); // older databases
} catch {
  /* column already exists */
}
export type MailDraft = { to: string; subject: string; body: string; imageIds: number[]; ts: number };
const upsertMailDraft = db.prepare(
  'INSERT INTO mail_drafts (chat, to_addr, subject, body, image_ids, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat) DO UPDATE SET to_addr=excluded.to_addr, subject=excluded.subject, body=excluded.body, image_ids=excluded.image_ids, ts=excluded.ts',
);
const selectMailDraft = db.prepare('SELECT to_addr, subject, body, image_ids, ts FROM mail_drafts WHERE chat = ?');
const deleteMailDraft = db.prepare('DELETE FROM mail_drafts WHERE chat = ?');
export const setMailDraft = (chat: string, to: string, subject: string, body: string, imageIds: number[] = []): void => {
  upsertMailDraft.run(chat, to, subject, body, JSON.stringify(imageIds), Date.now());
};
export const getMailDraft = (chat: string): MailDraft | undefined => {
  const r = selectMailDraft.get(chat) as { to_addr: string; subject: string; body: string; image_ids: string; ts: number } | undefined;
  return r ? { to: r.to_addr, subject: r.subject, body: r.body, imageIds: JSON.parse(r.image_ids) as number[], ts: r.ts } : undefined;
};
export const clearMailDraft = (chat: string): void => {
  deleteMailDraft.run(chat);
};

/** The full-frame (unpadded) copy of an image, kept for email attachments. */
export const mailCopyPath = (p: string): string => p.replace(/\.jpg$/, '.mail.jpg');
/** Delete an image file and its email copy. */
export const rmImageFiles = (p: string): void => {
  fs.rmSync(p, { force: true });
  fs.rmSync(mailCopyPath(p), { force: true });
};
