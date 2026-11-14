import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { ToolDef } from './llm.js';
import { createDraft } from './post.js';
import { TOOL_TEXT } from './prompts.js';
import { canSendEmail, createMailDraft, sendMailDraft } from './send-mail.js';

export type ToolCtx = { draftPreview?: string
  /** Ground-truth status of an email action, appended to the reply by code (not by the model). */
  notice?: string;
  /** What the user's own message asked for; overrides the model's choice between send_email and draft_email. */
  emailIntent?: 'send' | 'draft';
};

export const chatDir = (chatId: string): string => {
  const dir = path.join(config.dataDir, 'chats', chatId.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const readMemory = (chatId: string): string => {
  const file = path.join(chatDir(chatId), 'MEMORY.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-4000) : '';
};

export function toolDefs(): ToolDef[] {
  const defs: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'remember',
        description: TOOL_TEXT.remember.description,
        parameters: {
          type: 'object',
          properties: { note: { type: 'string', description: TOOL_TEXT.remember.note } },
          required: ['note'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: TOOL_TEXT.get_time.description,
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  if (config.igEnabled) {
    defs.push({
      type: 'function',
      function: {
        name: 'prepare_instagram_post',
        description: TOOL_TEXT.prepare_instagram_post.description,
        parameters: {
          type: 'object',
          properties: { caption: { type: 'string', description: TOOL_TEXT.prepare_instagram_post.caption } },
          required: ['caption'],
        },
      },
    });
  }
  if (canSendEmail()) {
    const emailParameters = {
      type: 'object',
      properties: {
        to: { type: 'string', description: TOOL_TEXT.emailParams.to },
        subject: { type: 'string' },
        body: { type: 'string', description: TOOL_TEXT.emailParams.body },
        attach_images: { type: 'boolean', description: TOOL_TEXT.emailParams.attach_images },
      },
      required: ['to', 'subject', 'body'],
    };
    defs.push(
      { type: 'function', function: { name: 'send_email', description: TOOL_TEXT.send_email.description, parameters: emailParameters } },
      { type: 'function', function: { name: 'draft_email', description: TOOL_TEXT.draft_email.description, parameters: emailParameters } },
      { type: 'function', function: { name: 'send_draft', description: TOOL_TEXT.send_draft.description, parameters: { type: 'object', properties: {} } } },
    );
  }
  if (config.enableShell) {
    defs.push({
      type: 'function',
      function: {
        name: 'shell',
        description: TOOL_TEXT.shell.description,
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    });
  }
  return defs;
}

export async function runTool(chatId: string, name: string, rawArgs: string, ctx: ToolCtx = {}): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return 'Error: tool arguments were not valid JSON.';
  }
  switch (name) {
    case 'remember': {
      const note = String(args.note ?? '').trim().slice(0, 500);
      if (!note) return 'Error: empty note.';
      if (/pass(word|code)|api[ _-]?key|secret|token|\b\d{13,19}\b/i.test(note)) return 'Error: not saving sensitive data. Do not retry.';
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (readMemory(chatId).split('\n').some((l) => norm(l.replace(/^- /, '')) === norm(note))) return 'Already saved.';
      fs.appendFileSync(path.join(chatDir(chatId), 'MEMORY.md'), `- ${note}\n`);
      return 'Saved.';
    }
    case 'prepare_instagram_post': {
      const r = createDraft(chatId, String(args.caption ?? ''));
      if (!r.ok) return `Error: ${r.text}`;
      ctx.draftPreview = r.text;
      return 'Draft saved. The system will show the user the draft and ask them to /confirm. Do NOT say it has been posted.';
    }
    case 'send_email':
    case 'draft_email': {
      const mode = ctx.emailIntent ?? (name === 'send_email' ? 'send' : 'draft');
      const r = createMailDraft(chatId, String(args.to ?? ''), String(args.subject ?? ''), String(args.body ?? ''), args.attach_images === true);
      if (!r.ok) return `Error: ${r.text}`;
      if (mode === 'send') {
        const sent = await sendMailDraft(chatId);
        ctx.notice = sent.text;
        return sent.ok
          ? `${sent.text} It is already delivered. Do not call it a draft and do not mention /send.`
          : `Not sent. ${sent.text}`;
      }
      ctx.draftPreview = r.text;
      return 'Draft saved (NOT sent). The user will see it. They can tell you to send it, or reply /send.';
    }
    case 'send_draft': {
      const sent = await sendMailDraft(chatId);
      ctx.notice = sent.text;
      return sent.ok ? `${sent.text} It is already delivered. Do not mention /send.` : `Not sent. ${sent.text}`;
    }
    case 'get_time':
      return new Date().toString();
    case 'shell': {
      if (!config.enableShell) return 'Error: shell tool is disabled.';
      const command = String(args.command ?? '');
      return new Promise((resolve) => {
        execFile(
          'bash',
          ['-c', command],
          { cwd: chatDir(chatId), timeout: 30_000, maxBuffer: 1 << 20 },
          (err, stdout, stderr) => {
            const out = `${stdout}${stderr}`.trim().slice(0, 4000);
            resolve(err && !out ? `Error: ${err.message}` : out || '(no output)');
          },
        );
      });
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}
