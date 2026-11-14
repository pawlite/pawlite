import { config } from './config.js';
import { addMessage, clearChat, getSummary, pendingImages, recent, type Row } from './db.js';
import { compactChat, scheduleCompaction } from './compact.js';
import { chatCompletion, stripReasoning, type Msg, type Part } from './llm.js';
import { visionDataUrl } from './media.js';
import { cancelDraft, confirmDraft, createDraft } from './post.js';
import { buildSystemPrompt, helpText } from './prompts.js';
import { canSendEmail, cancelMailDraft, emailIntent, isSendConfirmation, sendMailDraft } from './send-mail.js';
import { readMemory, runTool, toolDefs, type ToolCtx } from './tools.js';
import fs from 'node:fs';
import { clearPendingImages } from './cleanup.js';

const MAX_TOOL_STEPS = 5;

function systemPrompt(chatId: string): string {
  return buildSystemPrompt({
    botName: config.botName,
    channel: chatId.startsWith('tg:') ? 'Telegram' : chatId.startsWith('em:') ? 'email' : 'WhatsApp',
    now: new Date(),
    instagramEnabled: config.igEnabled,
    emailEnabled: canSendEmail(),
    waitingImages: pendingImages(chatId).length,
    memory: readMemory(chatId),
    summary: getSummary(chatId)?.summary,
  });
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
      return helpText({ email: canSendEmail(), instagram: config.igEnabled });
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

  // A bare "send it" always refers to the pending draft: handled by code, never by the model (which could invent a new email).
  if (canSendEmail() && isSendConfirmation(text)) return (await sendMailDraft(chatId)).text;

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
  const ctx: ToolCtx = { emailIntent: emailIntent(text) };

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const reply = await chatCompletion(messages, tools);
      if (!reply.tool_calls?.length) {
        let out = clean(typeof reply.content === 'string' ? reply.content : '');
        if (ctx.draftPreview) out = out ? `${out}\n\n${ctx.draftPreview}` : ctx.draftPreview;
        if (ctx.notice) out = out ? `${out}\n\n${ctx.notice}` : ctx.notice;
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
