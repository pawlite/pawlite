// Drafting an email is done by code, not by the model deciding to call a tool: small local models often just write the
// email in the chat and claim it was saved. Here the model only fills in {to, subject, body}; code saves the draft.
import { chatCompletion, stripReasoning } from './llm.js';
import { createMailDraft } from './send-mail.js';
import { readMemory } from './tools.js';

const ADDRESS = /[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/;

/** "Draft an email to bob@x.com saying ..." (or "... an email to Anna ..."): a draft/write verb, the word email/mail, and
 *  either an address in the message or "email to <name>" (the address is then looked up in the chat's memory). */
export const looksLikeDraftRequest = (text: string): boolean =>
  /\b(draft|write|prepare|compose)\b/i.test(text) &&
  /\be-?mail\b|\bmail\b/i.test(text) &&
  (ADDRESS.test(text) || /\b(?:e-?mail|mail)\s+(?:to|for)\s+\S+/i.test(text));

const system = (memory: string): string =>
  'You turn the user\'s request into ONE email draft. Reply with ONLY a JSON object and nothing else: ' +
  '{"to":"<the one email address of the recipient>","subject":"<subject>","body":"<plain-text email body>"}. ' +
  'The address must be written in the request, or in the notes below when the user names a person. If you cannot find it, use "to":"". Never invent an address. ' +
  'Use the subject and wording the user gave. If they gave no wording, write 1 to 4 short, polite sentences. No markdown.' +
  (memory ? `\n\nNotes about the user (use only to find a recipient's address):\n${memory.slice(-2000)}` : '');

export async function draftEmailFromRequest(chatId: string, text: string): Promise<string> {
  const fail = 'I could not turn that into an email draft. Please give the recipient address, the subject and what to say, and nothing was saved.';
  const memory = readMemory(chatId);
  try {
    const reply = await chatCompletion(
      [{ role: 'system', content: system(memory) }, { role: 'user', content: text }],
      undefined,
      { temperature: 0.2, maxTokens: 700 },
    );
    const raw = stripReasoning(typeof reply.content === 'string' ? reply.content : '');
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return fail;
    const o = JSON.parse(json) as { to?: unknown; subject?: unknown; body?: unknown };
    const to = String(o.to ?? '').trim();
    // The address must really appear in the request or in memory: the model may not invent one.
    if (!to || !`${text}\n${memory}`.toLowerCase().includes(to.toLowerCase()))
      return 'I do not have an email address for that recipient. Send me the address (and I will remember it if you ask), and nothing was saved.';
    const r = createMailDraft(chatId, to, String(o.subject ?? ''), String(o.body ?? ''));
    console.log(`[draft] ${chatId}: ${r.ok ? 'saved' : 'refused'}: ${r.text.slice(0, 80).replace(/\s+/g, ' ')}`);
    return r.ok ? r.text : `❌ ${r.text}`;
  } catch (e) {
    console.log(`[draft] ${chatId}: failed: ${e instanceof Error ? e.message : e}`);
    return fail;
  }
}
