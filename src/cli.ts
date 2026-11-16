// Talk to the agent from the terminal (no chat apps). Same agent, tools, memory, drafts and compaction as the
// chat channels (text only: no images). Run with: npm run chat
import readline from 'node:readline';
import { respond } from './agent.js';
import { runExclusive } from './queue.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
console.log('PawLite CLI. Ctrl+C to quit. Try /help; /new resets the conversation.');
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  // Through the queue, so an automatic compaction (scheduled after the previous reply) never overlaps this turn.
  if (line) console.log(`bot> ${await runExclusive(() => respond('cli', line))}`);
  rl.prompt();
}
