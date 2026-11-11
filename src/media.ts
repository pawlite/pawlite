import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { addImage, deleteImages, mailCopyPath, staleImages, rmImageFiles } from './db.js';

const MIN_RATIO = 0.8; // 4:5
const MAX_RATIO = 1.91; // 1.91:1
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Normalise any incoming image into something Instagram accepts:
 * sRGB JPEG, EXIF-rotated, <= 1440px wide, aspect ratio padded into 4:5 .. 1.91:1, < 8 MB.
 * (Padding rather than cropping, so nothing is cut off.)
 */
export async function saveImage(chat: string, input: Buffer): Promise<string> {
  const rotated = await sharp(input).rotate().resize({ width: 1440, withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const { width, height } = rotated.info;
  let pipeline = sharp(rotated.data).flatten({ background: '#ffffff' });

  const ratio = width / height;
  if (ratio < MIN_RATIO) {
    pipeline = pipeline.resize({ width: Math.ceil(height * MIN_RATIO), height, fit: 'contain', background: '#ffffff' });
  } else if (ratio > MAX_RATIO) {
    pipeline = pipeline.resize({ width, height: Math.ceil(width / MAX_RATIO), fit: 'contain', background: '#ffffff' });
  }

  const base = pipeline.toColourspace('srgb');
  let out = await base.clone().jpeg({ quality: 90 }).toBuffer();
  if (out.length > MAX_BYTES) out = await base.clone().jpeg({ quality: 75 }).toBuffer();

  const dir = path.join(config.dataDir, 'media', chat.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`);
  fs.writeFileSync(file, out);
  // Unpadded copy for email attachments (the padded one is shaped for Instagram).
  const mailCopy = await sharp(input).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
  fs.writeFileSync(mailCopyPath(file), mailCopy);
  addImage(chat, file);
  return file;
}

/** Small base64 data URL for vision-capable models. */
export async function visionDataUrl(file: string): Promise<string> {
  const buf = await sharp(file).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** Delete unposted images older than `maxAgeMs` (default 7 days). */
export function pruneImages(maxAgeMs = 7 * 24 * 3600 * 1000): void {
  const stale = staleImages(Date.now() - maxAgeMs);
  for (const r of stale) rmImageFiles(r.path);
  deleteImages(stale.map((r) => r.id));
}
