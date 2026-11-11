import { config } from './config.js';
import { addMessage, clearChat, getSummary, pendingImages, recent, type Row } from './db.js';
import { compactChat, scheduleCompaction } from './compact.js';
import { chatCompletion, stripReasoning, type Msg, type Part } from './llm.js';
import { visionDataUrl } from './media.js';
import { cancelDraft, confirmDraft, createDraft } from './post.js';
import { canSendEmail, cancelMailDraft, sendMailDraft } from './send-mail.js';
import { readMemory, runTool, toolDefs, type ToolCtx } from './tools.js';
import fs from 'node:fs';
import { clearPendingImages } from './cleanup.js';

const MAX_TOOL_STEPS = 5;

function systemPrompt(chatId: string): string {
  const channel = chatId.startsWith('tg:') ? 'Telegram' : chatId.startsWith('em:') ? 'email' : 'WhatsApp';
  const memory = readMemory(chatId);
  const summary = getSummary(chatId)?.summary;
  const waiting = pendingImages(chatId).length;
  return [
    `You are ${config.botName}, a concise personal assistant chatting over ${channel}.`,
    channel === 'WhatsApp'
      ? 'Keep replies short and plain. Use *single asterisks* for bold; no markdown headings or tables.'
      : channel === 'email'
        ? 'You are replying by email: plain text only, no markdown, no subject line, no signature.'
        : 'Keep replies short and plain text. No markdown formatting.',
    `Current time: ${new Date().toString()}`,
    config.igEnabled
      ? `You can post to Instagram. Images the user has sent and not yet posted: ${waiting}. ` +
        'When the user wants to post them, write a good caption (hashtags optional) and call prepare_instagram_post. ' +
        'That only creates a draft; the user must reply /confirm. Never claim something was posted.'
      : '',
    canSendEmail()
      ? 'You CAN send email. If the user asks you to send or email something, call send_email. If they ask you to draft or write one, call draft_email ' +
        '(it is saved, not sent); when they later say to send it, call send_draft. Never send when they only asked for a draft, and report results honestly. ' +
        `One recipient per email. Images the user has sent in this chat: ${waiting}; to include them set attach_images=true (they go as attachments). You cannot read or search the inbox.`
      : '',
    memory ? `What you remember about this chat:\n${memory}` : '',
    summary ? `Summary of the earlier conversation:\n${summary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function trimHistory(rows: Row[]): Row[] {
  const kept: Row[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    used += rows[i].content.length;
    if (used > config.historyChars && kept.length > 0) break;
    kept.unshift(rows[i]);
  }
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

const clean = stripReasoning;

const HELP =
  '/new – clear this conversation\n/help – this message\n/memory – show what I remember\n/compact – tidy up memory and summarize old messages\n' +
  (canSendEmail() ? '/send – send the drafted email\n' : '') +
  (config.igEnabled
    ? '/post <caption> – draft an Instagram post from the images you sent\n/confirm – publish the draft\n/cancel – discard the draft\n/clearimages – delete unposted images'
    : '');

export type RespondOpts = { newImages?: string[] };

export async function respond(chatId: string, rawText: string, opts: RespondOpts = {}): Promise<string> {
  const text = rawText.trim();
  const [first = '', ...restWords] = text.split(/\s+/);
  const cmd = first.toLowerCase();

  switch (cmd) {
    case '/new':
    case '/reset':
      clearChat(chatId);
      return 'Fresh conversation started. (Long-term memory is kept.)';
    case '/help':
      return HELP;
    case '/memory': {
      const m = readMemory(chatId).trim();
      return m ? `What I remember:\n${m}` : 'Nothing saved to long-term memory yet.';
    }
    case '/compact':
      return compactChat(chatId, true);
    case '/confirm':
      return confirmDraft(chatId);
    case '/send':
      return (await sendMailDraft(chatId)).text;
    case '/cancel': {
      const mail = cancelMailDraft(chatId);
      const ig = cancelDraft(chatId);
      return mail ? 'Email draft discarded.' : ig;
    }
    case '/clearimages':
      return `Deleted ${clearPendingImages(chatId)} unposted image(s).`;
    case '/post': {
      const caption = text.slice(first.length).trim();
      return caption ? createDraft(chatId, caption).text : 'Usage: /post <caption>';
    }
  }
  void restWords;

  const newImages = opts.newImages ?? [];
  const stored = newImages.length ? `[user sent ${newImages.length} image(s)] ${text}`.trim() : text;
  addMessage(chatId, 'user', stored);

  const messages: Msg[] = [
    { role: 'system', content: systemPrompt(chatId) },
    ...trimHistory(recent(chatId, 40)).map((r): Msg => ({ role: r.role, content: r.content })),
  ];

  // Optional: let a vision-capable model actually look at the new images (needs llama-server --mmproj).
  if (config.vision && newImages.length) {
    const parts: Part[] = [{ type: 'text', text: stored }];
    for (const f of newImages.slice(0, 4)) {
      if (fs.existsSync(f)) parts.push({ type: 'image_url', image_url: { url: await visionDataUrl(f) } });
    }
    messages[messages.length - 1] = { role: 'user', content: parts };
  }

  const tools = config.useTools ? toolDefs() : undefined;
  const ctx: ToolCtx = {};

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const reply = await chatCompletion(messages, tools);
      if (!reply.tool_calls?.length) {
        let out = clean(typeof reply.content === 'string' ? reply.content : '');
        if (ctx.draftPreview) out = out ? `${out}\n\n${ctx.draftPreview}` : ctx.draftPreview;
        out ||= '(no response)';
        addMessage(chatId, 'assistant', out);
        scheduleCompaction(chatId); // if this chat is now over its token limits, compact it after this reply
        return out;
      }
      messages.push(reply);
      for (const call of reply.tool_calls) {
        const result = await runTool(chatId, call.function.name, call.function.arguments, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return 'I got stuck in a tool loop. Try rephrasing, or send /new.';
  } catch (err) {
    return `⚠️ LLM error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Convert common markdown to WhatsApp formatting, leaving code fences alone. */
export function toWhatsApp(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith('```')
        ? part
        : part
            .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
            .replace(/\*\*(.+?)\*\*/g, '*$1*')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)'),
    )
    .join('');
}
