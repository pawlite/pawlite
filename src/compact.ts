import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { allChats, getSummary, liveMessages, setSummary } from './db.js';
import { chatCompletion, stripReasoning } from './llm.js';
import { runExclusive } from './queue.js';
import { chatDir } from './tools.js';

// Matches "- text", "* text", "• text" or "1. text" and captures the text.
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
// Cap on how much old conversation goes into one summarizing request.
const MAX_TRANSCRIPT_CHARS = 12_000;

/** Rough token estimate: characters / charsPerToken. Good enough to decide when to compact. */
export const estTokens = (text: string): number => Math.ceil(text.length / config.charsPerToken);

// If a compaction attempt does not shrink a chat (model failed, or the rewrite was rejected), do not
// retry on every reply: only try again once the content has grown another 20% since the failed attempt.
const failedAt = new Map<string, number>();
const worthRetrying = (key: string, size: number): boolean => {
  const prev = failedAt.get(key);
  return prev === undefined || size > prev * 1.2 + 50;
};

// One plain request/response to the model (no tools), at low temperature for stable output.
async function ask(system: string, user: string, maxTokens: number): Promise<string> {
  const r = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    undefined,
    { maxTokens, temperature: 0.2 },
  );
  return stripReasoning(typeof r.content === 'string' ? r.content : '');
}

/** Rewrite MEMORY.md as a shorter, deduplicated list. The old file is kept as MEMORY.md.bak. */
export async function compactMemory(chat: string, force = false): Promise<string> {
  const file = path.join(chatDir(chat), 'MEMORY.md');
  if (!fs.existsSync(file)) return 'Memory: nothing saved yet.';
  const original = fs.readFileSync(file, 'utf8').trim();
  if (!original) return 'Memory: empty.';

  const size = estTokens(original);
  const key = `${chat}:mem`;
  // Automatic runs only act above the token limit (and not repeatedly after a failed attempt); /compact (force) always tries.
  if (!force && (size <= config.compactMemoryTokens || !worthRetrying(key, size))) {
    return `Memory: ~${size} tokens, no compaction needed (limit ${config.compactMemoryTokens}).`;
  }
  failedAt.set(key, size); // cleared again below if the rewrite is accepted

  const targetChars = Math.floor(config.compactMemoryTokens * config.charsPerToken * 0.7); // aim comfortably below the limit
  const out = await ask(
    "You clean up an assistant's long-term memory notes about a user. Rewrite the notes as a deduplicated list of short bullets. " +
      'Keep every distinct fact (names, numbers, dates, preferences, standing instructions). Merge duplicates. ' +
      'If two notes contradict each other, keep only the later one. Do not invent anything. ' +
      `Aim for under ${targetChars} characters. Output ONLY the bullets, each starting with "- ".`,
    original,
    1500,
  );

  // Never trust a small model blindly: keep only bullet lines (drops any "Here is the list:" preamble)...
  const lines = out.split('\n').map((l) => BULLET.exec(l)?.[1]).filter((x): x is string => Boolean(x));
  const rewritten = lines.map((l) => `- ${l}`).join('\n');
  // ...and only accept a clean, shorter, non-trivial result.
  if (!lines.length) return 'Memory: the model did not return a bullet list, original kept.';
  if (rewritten.length >= original.length) return 'Memory: no shorter version found, original kept.';
  if (rewritten.length < original.length * 0.1) return 'Memory: rewrite looked too lossy, original kept.';

  fs.copyFileSync(file, `${file}.bak`); // safety copy of the previous version
  fs.writeFileSync(`${file}.tmp`, `${rewritten}\n`); // write to a temp file, then swap it in
  fs.renameSync(`${file}.tmp`, file); // so a crash can't leave a half-written memory file
  failedAt.delete(key);
  return `Memory: ~${size} → ~${estTokens(rewritten)} tokens (old version saved as MEMORY.md.bak).`;
}

/** Fold the oldest messages into a running summary; the newest few stay verbatim. */
export async function compactHistory(chat: string, force = false): Promise<string> {
  const live = liveMessages(chat); // messages not yet folded into a summary
  const keep = config.compactKeepMessages;
  const size = estTokens(live.map((m) => m.content).join('\n'));
  const key = `${chat}:hist`;
  if (live.length <= keep || (!force && (size <= config.compactHistoryTokens || !worthRetrying(key, size)))) {
    return `History: ${live.length} live message(s), ~${size} tokens, no compaction needed (limit ${config.compactHistoryTokens}).`;
  }
  failedAt.set(key, size); // cleared again below on success

  // Everything except the newest `keep` messages is eligible, oldest first.
  const lines: string[] = [];
  let used = 0;
  let uptoId = 0; // id of the last message we actually include
  for (const m of live.slice(0, live.length - keep)) {
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 600)}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS && lines.length) break; // the rest is handled next run
    lines.push(line);
    used += line.length;
    uptoId = m.id;
  }

  // Merge the old summary (if any) with the new messages into one updated summary.
  const previous = getSummary(chat)?.summary ?? '';
  const summary = (
    await ask(
      'You maintain a running summary of a chat between a user and an assistant. Merge the previous summary with the new messages ' +
        "into one updated summary. Keep the user's goals, decisions, open tasks, names, dates, preferences and anything promised. " +
        `Drop greetings and small talk. Plain text, at most ${config.compactSummaryWords} words. Output ONLY the summary.`,
      `Previous summary:\n${previous || '(none)'}\n\nNew messages:\n${lines.join('\n')}`,
      700,
    )
  ).slice(0, 4000);
  if (!summary) return 'History: the model returned an empty summary, nothing changed.';

  // Messages with id <= uptoId are now represented by the summary and no longer sent verbatim.
  setSummary(chat, summary, uptoId);
  failedAt.delete(key);
  return `History: summarized ${lines.length} message(s); ${live.length - lines.length} remain live.`;
}

/** Run both compactions for one chat. Errors are reported in the text instead of thrown. */
export async function compactChat(chat: string, force = false): Promise<string> {
  const parts: string[] = [];
  for (const job of [compactMemory, compactHistory]) {
    try {
      parts.push(await job(chat, force));
    } catch (e) {
      parts.push(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parts.join('\n');
}

/** Compact one chat if it is over its limits; log only when something changed or failed. */
async function compactIfNeeded(chat: string): Promise<void> {
  const report = await compactChat(chat, false);
  if (/→|summarized/.test(report)) console.log(`Compaction [${chat}]\n${report}`);
  else if (/Failed/.test(report)) console.error(`Compaction [${chat}]\n${report}`);
}

/**
 * Called after every reply. Queues a compaction for this chat if it is over its limits.
 * It runs AFTER the reply was sent (so the user is not kept waiting), through the shared queue so it
 * never overlaps a conversation turn. Note that the next message waits if compaction is still running.
 */
const scheduled = new Set<string>();
export function scheduleCompaction(chat: string): void {
  if (!config.compactEnabled || scheduled.has(chat)) return;
  scheduled.add(chat);
  void runExclusive(() => compactIfNeeded(chat))
    .catch((e) => console.error('Compaction failed:', e))
    .finally(() => scheduled.delete(chat));
}

/** Optional backstop: also check every chat on a timer (catches hand-edited MEMORY.md files, idle chats). */
export function startCompaction(): void {
  if (!config.compactEnabled || !(config.compactIntervalMinutes > 0)) return; // timer off (the default)
  console.log(`Compaction: also checking all chats every ${config.compactIntervalMinutes} min`);
  setInterval(() => {
    void runExclusive(async () => {
      for (const chat of allChats()) await compactIfNeeded(chat);
    }).catch((e) => console.error('Compaction failed:', e));
  }, config.compactIntervalMinutes * 60_000);
}
