import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { ToolDef } from './llm.js';
import { createDraft } from './post.js';
import { canSendEmail, createMailDraft, sendMailDraft } from './send-mail.js';

export type ToolCtx = { draftPreview?: string };

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
        description: 'Save a short durable fact about the user or their preferences to long-term memory.',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string', description: 'One concise fact to remember' } },
          required: ['note'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get the current date and time.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  if (config.igEnabled) {
    defs.push({
      type: 'function',
      function: {
        name: 'prepare_instagram_post',
        description:
          'Draft an Instagram post from the images the user sent that are still waiting. Does NOT publish: the user must confirm with /confirm.',
        parameters: {
          type: 'object',
          properties: { caption: { type: 'string', description: 'Final caption text, max 2200 chars, up to 30 hashtags' } },
          required: ['caption'],
        },
      },
    });
  }
  if (canSendEmail()) {
    defs.push(
      {
        type: 'function',
        function: {
          name: 'send_email',
          description: 'Send a NEW email to one recipient immediately. Use only when the user asks you to SEND/email something.',
          parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'One recipient email address' },
            subject: { type: 'string' },
            body: { type: 'string', description: 'Plain-text body, no markdown' },
            attach_images: { type: 'boolean', description: 'true to attach the images the user has sent in this chat' },
          },
          required: ['to', 'subject', 'body'],
        },
        },
      },
      {
        type: 'function',
        function: {
          name: 'draft_email',
          description: 'Write a NEW email and save it as a draft WITHOUT sending. Use when the user asks you to draft/write/prepare an email.',
          parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'One recipient email address' },
            subject: { type: 'string' },
            body: { type: 'string', description: 'Plain-text body, no markdown' },
            attach_images: { type: 'boolean', description: 'true to attach the images the user has sent in this chat' },
          },
          required: ['to', 'subject', 'body'],
        },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_draft',
          description: 'Send the email draft saved earlier by draft_email. Use when the user says to send the draft.',
          parameters: { type: 'object', properties: {} },
        },
      },
    );
  }
  if (config.enableShell) {
    defs.push({
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a bash command in this chat\'s working directory (30s timeout).',
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
      fs.appendFileSync(path.join(chatDir(chatId), 'MEMORY.md'), `- ${note}\n`);
      return 'Saved.';
    }
    case 'prepare_instagram_post': {
      const r = createDraft(chatId, String(args.caption ?? ''));
      if (!r.ok) return `Error: ${r.text}`;
      ctx.draftPreview = r.text;
      return 'Draft saved. The system will show the user the draft and ask them to /confirm. Do NOT say it has been posted.';
    }
    case 'send_email': {
      const r = createMailDraft(chatId, String(args.to ?? ''), String(args.subject ?? ''), String(args.body ?? ''), args.attach_images === true);
      if (!r.ok) return `Error: ${r.text}`;
      const sent = await sendMailDraft(chatId);
      return sent.ok ? sent.text : `Not sent. ${sent.text}`;
    }
    case 'draft_email': {
      const r = createMailDraft(chatId, String(args.to ?? ''), String(args.subject ?? ''), String(args.body ?? ''), args.attach_images === true);
      if (!r.ok) return `Error: ${r.text}`;
      ctx.draftPreview = r.text;
      return 'Draft saved (NOT sent). The user will see it. They can tell you to send it, or reply /send.';
    }
    case 'send_draft': {
      const sent = await sendMailDraft(chatId);
      return sent.ok ? sent.text : `Not sent. ${sent.text}`;
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
