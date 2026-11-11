import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { config } from './config.js';

// Instagram's servers download each image from a public URL while a post is being created.
// We expose ONLY the files of the post currently being published, under unguessable tokens,
// and remove them as soon as publishing finishes.
const served = new Map<string, string>(); // token -> file path

export function startMediaServer(): void {
  if (!config.igEnabled) return;
  http
    .createServer((req, res) => {
      const m = /^\/m\/([a-f0-9]{32})\.jpg$/.exec(req.url ?? '');
      const file = m ? served.get(m[1]) : undefined;
      if (!file || !fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(file).pipe(res);
    })
    .listen(config.httpPort, config.httpHost, () =>
      console.log(`Media server on ${config.httpHost}:${config.httpPort} → public URL ${config.publicBaseUrl}`),
    );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function graph(method: 'GET' | 'POST', route: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const url = new URL(`${config.igHost}/${config.igVersion}/${route}`);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${config.igToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  };
  if (method === 'POST') init.body = JSON.stringify(params);
  else for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`Instagram API ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function waitReady(containerId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const { status_code } = await graph('GET', containerId, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`Instagram could not process the media (status ${status_code}).`);
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for Instagram to process the media.');
}

export async function publishToInstagram(files: string[], caption: string): Promise<{ id: string; permalink?: string }> {
  if (!config.igEnabled) throw new Error('Instagram is not configured (IG_USER_ID, IG_ACCESS_TOKEN, PUBLIC_BASE_URL).');
  if (files.length < 1 || files.length > 10) throw new Error('An Instagram post needs 1-10 images.');

  const tokens: string[] = [];
  try {
    const urls = files.map((f) => {
      const t = crypto.randomBytes(16).toString('hex');
      served.set(t, f);
      tokens.push(t);
      return `${config.publicBaseUrl}/m/${t}.jpg`;
    });

    let creationId: string;
    if (files.length === 1) {
      creationId = (await graph('POST', `${config.igUserId}/media`, { image_url: urls[0], caption })).id as string;
      await waitReady(creationId);
    } else {
      const children: string[] = [];
      for (const u of urls) {
        children.push((await graph('POST', `${config.igUserId}/media`, { image_url: u, is_carousel_item: true })).id as string);
      }
      for (const c of children) await waitReady(c);
      creationId = (
        await graph('POST', `${config.igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })
      ).id as string;
      await waitReady(creationId);
    }

    const published = await graph('POST', `${config.igUserId}/media_publish`, { creation_id: creationId });
    const info = await graph('GET', published.id as string, { fields: 'permalink' }).catch(() => ({}) as Record<string, any>);
    return { id: published.id as string, permalink: info.permalink as string | undefined };
  } finally {
    for (const t of tokens) served.delete(t);
  }
}
