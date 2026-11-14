/**
 * prompts.ts (SAMPLE): every piece of text the model sees, in one place.
 *
 * Rules for this file:
 *  - Text only. No fs, no database, no network: other files pass in plain values.
 *  - Behaviour that must NOT depend on the model (email send-vs-draft rule, secret filter,
 *    dedupe, rate limits) stays in code (send-mail.ts, tools.ts), not here.
 */

// ───────────────────────── 1. System prompt ─────────────────────────

export type PromptInput = {
  botName: string;
  channel: 'WhatsApp' | 'Telegram' | 'email';
  now: Date;
  instagramEnabled: boolean;
  emailEnabled: boolean;
  waitingImages: number;
  memory: string; // contents of MEMORY.md (may be empty)
  summary?: string; // summary of earlier conversation (may be empty)
};

const STYLE: Record<PromptInput['channel'], string> = {
  WhatsApp: 'Keep replies short and plain. Use *single asterisks* for bold; no markdown headings or tables.',
  email: 'You are replying by email: plain text only, no markdown, no subject line, no signature.',
  Telegram: 'Keep replies short and plain text. No markdown formatting.',
};

const INSTAGRAM = (waiting: number): string =>
  `You can post to Instagram. Images the user has sent and not yet posted: ${waiting}. ` +
  'When the user wants to post them, write a good caption (hashtags optional) and call prepare_instagram_post. ' +
  'That only creates a draft; the user must reply /confirm. Never claim something was posted.';

const EMAIL = (waiting: number): string =>
  'You CAN send email. When the user asks you to email someone, call send_email with the recipient, subject and body ' +
  "(the system itself decides whether to send now or save a draft, based on the user's wording, so never ask which). " +
  `One recipient per email. Images the user has sent in this chat: ${waiting}; to include them set attach_images=true. ` +
  'Report only what the tool result says. You cannot read or search the inbox.';

const MEMORY_RULES =
  'Long-term memory: when the user tells you a lasting fact (about themselves, their people, preferences, routines or projects), ' +
  'call remember right away with one short line, without announcing it. Never store passwords, keys or card numbers, ' +
  'and skip one-off requests or facts already listed below.';

export function buildSystemPrompt(p: PromptInput): string {
  return [
    `You are ${p.botName}, a concise personal assistant chatting over ${p.channel}.`,
    STYLE[p.channel],
    `Current time: ${p.now.toString()}`,
    p.instagramEnabled ? INSTAGRAM(p.waitingImages) : '',
    p.emailEnabled ? EMAIL(p.waitingImages) : '',
    MEMORY_RULES,
    p.memory ? `What you remember about this chat:\n${p.memory}` : '',
    p.summary ? `Summary of the earlier conversation:\n${p.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ───────────────────────── 2. Tool descriptions ─────────────────────────
// What the model reads when deciding which tool to call. Schemas stay next to the code that runs them in tools.ts.

export const TOOL_TEXT = {
  remember: {
    description:
      'Save ONE short, durable fact to long-term memory: names, preferences, people, routines, ongoing projects, decisions. ' +
      'Call it proactively whenever the user shares such a fact, without being asked and without announcing it. ' +
      'Never save passwords, keys, card numbers or one-off details.',
    note: 'One concise fact to remember',
  },
  get_time: { description: 'Get the current date and time.' },
  prepare_instagram_post: {
    description:
      'Draft an Instagram post from the images the user sent that are still waiting. Does NOT publish: the user must confirm with /confirm.',
    caption: 'Final caption text, max 2200 chars, up to 30 hashtags',
  },
  send_email: {
    description: 'Send a NEW email to one recipient immediately. Use only when the user asks you to SEND/email something.',
  },
  draft_email: {
    description: 'Write a NEW email and save it as a draft WITHOUT sending. Use when the user asks you to draft/write/prepare an email.',
  },
  send_draft: {
    description: 'Send the email draft saved earlier by draft_email. Use when the user says to send the draft.',
  },
  shell: { description: "Run a bash command in this chat's working directory (30s timeout)." },
  // Parameter descriptions shared by send_email and draft_email:
  emailParams: {
    to: 'One recipient email address',
    body: 'Plain-text body, no markdown',
    attach_images: 'true to attach the images the user has sent in this chat',
  },
} as const;

// ───────────────────────── 3. Compaction prompts ─────────────────────────
// Used by compact.ts for the model's housekeeping calls.

export const memoryRewritePrompt = (targetChars: number): string =>
  "You clean up an assistant's long-term memory notes about a user. Rewrite the notes as a deduplicated list of short bullets. " +
  'Keep every distinct fact (names, numbers, dates, preferences, standing instructions). Merge duplicates. ' +
  'If two notes contradict each other, keep only the later one. Do not invent anything. ' +
  `Aim for under ${targetChars} characters. Output ONLY the bullets, each starting with "- ".`;

export const summaryPrompt = (maxWords: number): string =>
  'You maintain a running summary of a chat between a user and an assistant. Merge the previous summary with the new messages ' +
  "into one updated summary. Keep the user's goals, decisions, open tasks, names, dates, preferences and anything promised. " +
  `Drop greetings and small talk. Plain text, at most ${maxWords} words. Output ONLY the summary.`;

export const summaryInput = (previous: string, transcript: string): string =>
  `Previous summary:\n${previous || '(none)'}\n\nNew messages:\n${transcript}`;

// ───────────────────────── 4. Text shown to the USER (not the model) ─────────────────────────
// Not model instructions, but easy to keep here too: command help and bot-written notices.

export const helpText = (o: { email: boolean; instagram: boolean }): string =>
  '/new – clear this conversation\n/help – this message\n/memory – show what I remember\n/compact – tidy up memory and summarize old messages\n' +
  (o.email ? '/send – send the drafted email\n' : '') +
  (o.instagram
    ? '/post <caption> – draft an Instagram post from the images you sent\n/confirm – publish the draft\n/cancel – discard the draft\n/clearimages – delete unposted images'
    : '');
