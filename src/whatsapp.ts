import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { toWhatsApp } from './agent.js';
import { config } from './config.js';
import { receive } from './inbound.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const userPart = (jid?: string | null): string => (jid ?? '').split('@')[0].split(':')[0];
const chunk = (s: string, n = 3500): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
};

function extractText(m: WAMessage): string {
  const c = normalizeMessageContent(m.message);
  return (
    c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? ''
  ).trim();
}

export async function startWhatsApp(): Promise<void> {
  if (!config.whatsappEnabled) return;
  const { state, saveCreds } = await useMultiFileAuthState(path.join(config.dataDir, 'whatsapp-auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const prefix = `${config.botName}: `;
  const trigger = new RegExp(`@${config.botName}\\b`, 'i');
  let pairingRequested = false;

  async function handleMessage(sock: WASocket, m: WAMessage): Promise<void> {
    const jid = m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || !m.message) return;

    const hasImage = Boolean(normalizeMessageContent(m.message)?.imageMessage);
    const text = extractText(m);
    if ((!text && !hasImage) || text.startsWith(prefix)) return; // nothing to do, or our own reply

    const isGroup = jid.endsWith('@g.us');
    const me = [userPart(sock.user?.id), userPart(sock.user?.lid)];
    const k = m.key as typeof m.key & { remoteJidAlt?: string; participantAlt?: string };

    if (m.key.fromMe) {
      // Only the "message yourself" chat, and only if enabled.
      if (!config.selfChat || isGroup || !me.includes(userPart(jid))) return;
    } else {
      const senderIds = [
        userPart(isGroup ? m.key.participant : jid),
        userPart(isGroup ? k.participantAlt : k.remoteJidAlt),
      ].filter(Boolean);
      if (!senderIds.some((id) => config.allowed.includes(id))) {
        console.log(`Ignored message from ${senderIds.join('/')} (not in ALLOWED_NUMBERS)`);
        return;
      }
      if (isGroup && !trigger.test(text)) return; // groups: only when addressed (caption the image with @name)
    }

    const images: Buffer[] = [];
    if (hasImage) {
      try {
        images.push(
          (await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })) as Buffer,
        );
      } catch (e) {
        console.error('WhatsApp image download failed:', e);
      }
    }

    await receive(`wa:${jid}`, text.replace(trigger, '').trim(), images, {
      send: async (t) => {
        for (const part of chunk(toWhatsApp(t))) await sock.sendMessage(jid, { text: prefix + part });
      },
      typing: () => sock.sendPresenceUpdate('composing', jid),
    });
  }

  const connect = (): void => {
    const sock: WASocket = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (config.pairingPhone && !pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(config.pairingPhone);
            console.log(`\nPairing code: ${code}\nWhatsApp → Settings → Linked Devices → Link with phone number\n`);
          } catch (e) {
            console.error('Could not get pairing code, falling back to QR:', e);
            qrcode.generate(qr, { small: true });
          }
        } else if (!config.pairingPhone) {
          console.log('\nScan this QR: WhatsApp → Settings → Linked Devices → Link a device\n');
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === 'open') console.log(`WhatsApp: connected as ${userPart(sock.user?.id)}.`);
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error('WhatsApp logged out. Delete data/whatsapp-auth and restart to re-link.');
          process.exit(1);
        }
        console.log(`WhatsApp connection closed (${code ?? 'unknown'}), reconnecting…`);
        setTimeout(connect, 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) void handleMessage(sock, m).catch((e) => console.error('WhatsApp handler error:', e));
    });
  };

  connect();
}
