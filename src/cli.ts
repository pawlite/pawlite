// Talk to the agent from the terminal (no chat apps) to test your llama-server setup.
import readline from 'node:readline';
import { respond } from './agent.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
console.log('PawLite CLI. Ctrl+C to quit. /new resets the conversation.');
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line) console.log(`bot> ${await respond('cli', line)}`);
  rl.prompt();
}
