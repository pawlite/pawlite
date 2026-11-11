import { config } from './config.js';
import { pollAgentMail } from './email-agentmail.js';
import { pollImap } from './email-imap.js';

/** Poll each configured mailbox on a timer. Never overlaps with itself; logs each distinct error once. */
export function startEmail(): void {
  const jobs: { name: string; run: () => Promise<void> }[] = [];
  if (config.imapEnabled) jobs.push({ name: `IMAP ${config.imapUser}`, run: pollImap });
  if (config.agentmailEnabled) jobs.push({ name: `AgentMail ${config.agentmailInbox}`, run: pollAgentMail });
  if (!jobs.length) return;

  if (!config.emailAllowed.length) console.warn('Email: EMAIL_ALLOWED is empty, so the bot will ignore everyone.');
  console.log(`Email: checking ${jobs.map((j) => j.name).join(', ')} every ${config.emailPollSeconds}s`);

  for (const job of jobs) {
    let lastError = '';
    const tick = async (): Promise<void> => {
      try {
        await job.run();
        lastError = '';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== lastError) console.error(`Email (${job.name}) check failed:`, msg);
        lastError = msg;
      } finally {
        setTimeout(() => void tick(), config.emailPollSeconds * 1000);
      }
    };
    void tick();
  }
}
