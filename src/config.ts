import path from 'node:path';
import { type Logger } from 'imapflow';

const env = (k: string, d = ''): string => process.env[k] ?? d;
/** Positive number from env; falls back to the default if missing, empty or invalid. */
const posNum = (k: string, d: number): number => {
  const n = Number(process.env[k]);
  return process.env[k]?.trim() && Number.isFinite(n) && n > 0 ? n : d;
};
const errorLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (obj) => console.error(obj),
};
const bool = (k: string, d: boolean): boolean =>
  ['1', 'true', 'yes', 'on'].includes(env(k, d ? 'true' : 'false').toLowerCase());
const digits = (s: string): string => s.replace(/\D/g, '');
const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

const igUserId = env('IG_USER_ID');
const igToken = env('IG_ACCESS_TOKEN');
const publicBaseUrl = env('PUBLIC_BASE_URL').replace(/\/$/, '');

export const config = {
  // LLM
  llmUrl: env('LLM_BASE_URL', 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
  llmModel: env('LLM_MODEL', 'local'),
  llmApiKey: env('LLM_API_KEY'),
  temperature: Number(env('LLM_TEMPERATURE', '0.7')),
  maxTokens: Number(env('LLM_MAX_TOKENS', '1024')),
  thinking: bool('LLM_THINKING', false),
  useTools: bool('LLM_TOOLS', true),
  vision: bool('LLM_VISION', false),
  enableShell: bool('ENABLE_SHELL', false),
  botName: env('BOT_NAME', 'Claw'),
  historyChars: Number(env('HISTORY_CHARS', '12000')),

  // Compaction. Sizes are ESTIMATED tokens (characters / COMPACT_CHARS_PER_TOKEN); /compact always works.
  compactEnabled: bool('COMPACT_ENABLED', true), // automatic compaction after replies (and the optional timer)
  compactHistoryTokens: Number(env('COMPACT_HISTORY_TOKENS', '2500')), // summarize old messages above this
  compactMemoryTokens: Number(env('COMPACT_MEMORY_TOKENS', '900')), // rewrite MEMORY.md above this
  compactKeepMessages: Number(env('COMPACT_KEEP_MESSAGES', '10')), // newest messages always kept verbatim
  charsPerToken: Math.max(1, Number(env('COMPACT_CHARS_PER_TOKEN', '4'))), // ~4 for English; use 2-3 for CJK/emoji-heavy chats
  compactIntervalMinutes: Number(env('COMPACT_INTERVAL_MINUTES', '0')), // optional backstop timer; 0 = off
  compactSummaryWords: Number(env('COMPACT_SUMMARY_WORDS', '200')),
  dataDir: path.resolve(env('DATA_DIR') || './data'),

  // WhatsApp
  whatsappEnabled: bool('WHATSAPP_ENABLED', true),
  allowed: list(env('ALLOWED_NUMBERS')).map(digits).filter(Boolean),
  selfChat: bool('SELF_CHAT', false),
  pairingPhone: digits(env('PAIRING_PHONE')),

  // Telegram
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramApiBase: env('TELEGRAM_API_BASE', 'https://api.telegram.org').replace(/\/$/, ''),
  telegramAllowed: list(env('ALLOWED_TELEGRAM_IDS')),

  // Email: Gmail (or any IMAP/SMTP mailbox) and/or AgentMail
  emailAllowed: list(env('EMAIL_ALLOWED')).map((x) => x.toLowerCase()),
  emailPollSeconds: Math.max(15, Number(env('EMAIL_POLL_SECONDS', '60'))),
  emailRequireAuth: bool('EMAIL_REQUIRE_AUTH', true),
  // Sending NEW email (send_email tool + /send). By default only to addresses in EMAIL_ALLOWED.
  emailSendAny: bool('EMAIL_SEND_ANY', false),
  emailSendVia: env('EMAIL_SEND_VIA').toLowerCase(), // 'imap' | 'agentmail' | '' (auto)
  emailMaxRepliesPerHour: posNum('EMAIL_MAX_REPLIES_PER_HOUR', 20),
  imapErrorLogger: ["1", "true", "yes", "on"].includes(
      (env("IMAP_ERROR_LOGGER") ?? "").toLowerCase()
  )
      ? errorLogger
      : (false as const),
  imapHost: env('IMAP_HOST', 'imap.gmail.com'),
  imapPort: Number(env('IMAP_PORT', '993')),
  imapUser: env('IMAP_USER'),
  imapPassword: env('IMAP_PASSWORD'),
  smtpHost: env('SMTP_HOST', 'smtp.gmail.com'),
  smtpPort: Number(env('SMTP_PORT', '465')),
  imapEnabled: Boolean(env('IMAP_USER') && env('IMAP_PASSWORD')),
  agentmailKey: env('AGENTMAIL_API_KEY'),
  agentmailInbox: env('AGENTMAIL_INBOX_ID'),
  agentmailBase: env('AGENTMAIL_API_BASE', 'https://api.agentmail.to/v0').replace(/\/$/, ''),
  agentmailEnabled: Boolean(env('AGENTMAIL_API_KEY') && env('AGENTMAIL_INBOX_ID')),

  // Instagram (official Graph API content publishing)
  igUserId,
  igToken,
  igHost: env('IG_GRAPH_HOST', 'https://graph.instagram.com').replace(/\/$/, ''),
  igVersion: env('IG_API_VERSION', 'v25.0'),
  publicBaseUrl,
  httpHost: env('HTTP_HOST', '127.0.0.1'),
  httpPort: Number(env('HTTP_PORT', '8787')),
  igEnabled: Boolean(igUserId && igToken && publicBaseUrl),
};
