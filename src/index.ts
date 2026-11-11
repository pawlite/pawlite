import { config } from './config.js';
import { startCompaction } from './compact.js';
import { startEmail } from './email.js';
import { startMediaServer } from './instagram.js';
import { pruneSeen } from './db.js';
import { pruneImages } from './media.js';
import { startTelegram } from './telegram.js';
import { startWhatsApp } from './whatsapp.js';

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const channels = [
  config.whatsappEnabled && 'whatsapp',
  config.telegramToken && 'telegram',
  config.imapEnabled && 'imap',
  config.agentmailEnabled && 'agentmail',
].filter(Boolean);
console.log(
  `PawLite → ${config.llmUrl} | channels: ${channels.join(', ') || 'none'} | tools: ${config.useTools} | ` +
    `vision: ${config.vision} | instagram: ${config.igEnabled} | shell: ${config.enableShell}`,
);
if (config.whatsappEnabled && !config.allowed.length && !config.selfChat) {
  console.warn('WhatsApp: ALLOWED_NUMBERS is empty and SELF_CHAT is off, so the bot will ignore everyone.');
}
if (config.telegramToken && !config.telegramAllowed.length) {
  console.warn('Telegram: ALLOWED_TELEGRAM_IDS is empty, so the bot will ignore everyone.');
}
if ((config.igUserId || config.igToken) && !config.igEnabled) {
  console.warn('Instagram: set IG_USER_ID, IG_ACCESS_TOKEN and PUBLIC_BASE_URL together to enable posting.');
}

pruneImages();
pruneSeen();
startMediaServer();
startEmail();
startCompaction();
await Promise.all([startWhatsApp(), startTelegram()]);
