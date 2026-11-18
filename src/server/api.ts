// The app's local HTTP server (127.0.0.1 only): the UI's files, its JSON API and event stream, and the endpoints
// the MCP server calls for the agent. Every API call needs the launch token; agent calls need the running turn's.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { listenLocal } from 'openfilm/host';
import type { Studio } from './studio.js';
import { callTool, toolList } from './tools.js';
import { StaleRevisionError } from '../core/store.js';
import { projectPath } from '../core/paths.js';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };

const same = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function body(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
}

export async function startApi(studio: Studio, { uiDir, token, port = 0 }: { uiDir: string; token: string; port?: number }) {
  let listening = 0;
  const clients = new Set<ServerResponse>();
  studio.on('push', (m) => {
    const line = `data: ${JSON.stringify(m)}\n\n`;
    for (const c of clients) c.write(line);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const host = req.headers.host ?? '';
    // DNS rebinding: only our own address
    if (host !== `127.0.0.1:${listening}` && host !== `localhost:${listening}`) return void res.writeHead(421).end('wrong host');
    const origin = req.headers.origin;
    if (origin && origin !== studio.origin && origin !== `http://localhost:${listening}`) return void res.writeHead(403).end('wrong origin');
    try {
      // ---- agent tools (from the MCP server process) ----
      if (url.pathname.startsWith('/agent/')) {
        const t = String(req.headers['x-agent-token'] ?? '');
        if (!same(t, studio.agentToken)) return send(res, 401, { error: 'no agent turn is running for this token' });
        if (url.pathname === '/agent/tools' && req.method === 'GET') return send(res, 200, { tools: toolList() });
        if (url.pathname === '/agent/call' && req.method === 'POST') {
          const { name, args } = await body(req);
          const result = await callTool(String(name), args, studio);
          studio.noteTool(String(name), result);
          return send(res, 200, result);
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---- the UI's API ----
      if (url.pathname.startsWith('/api/')) {
        const t = String(req.headers['x-studio-token'] ?? url.searchParams.get('token') ?? '');
        if (!same(t, token)) return send(res, 401, { error: 'bad token' });
        const route = `${req.method} ${url.pathname}`;
        if (route === 'GET /api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: 'hello', data: studio.state() })}\n\n`);
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        if (route === 'GET /api/state') return send(res, 200, studio.state());
        if (route === 'GET /api/agents') return send(res, 200, await studio.harnesses());
        if (route === 'GET /api/annotation-image') {
          const s = studio.need();
          const a = s.annotations.find((x) => x.id === url.searchParams.get('id'));
          if (!a?.image) return send(res, 404, { error: 'no image' });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return void createReadStream(projectPath(s.root, a.image, { allowHidden: true })).pipe(res);
        }
        if (route === 'GET /api/export-file') {
          const s = studio.need();
          const job = studio.exports.find((j) => j.id === url.searchParams.get('id'));
          if (!job?.out || !existsSync(job.out)) return send(res, 404, { error: 'no file' });
          const size = statSync(job.out).size;
          const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
          if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Number(range[2]) : size - 1;
            res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
            return void createReadStream(job.out, { start, end }).pipe(res);
          }
          res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
          void s;
          return void createReadStream(job.out).pipe(res);
        }
        if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
        const b = await body(req);
        switch (url.pathname) {
          case '/api/project/create':
            return send(res, 200, await studio.create(String(b.name || 'Untitled'), b.parent));
          case '/api/project/open':
            return send(res, 200, await studio.open(String(b.path)));
          case '/api/import': {
            const out = [];
            for (const p of b.paths ?? []) out.push(await studio.need().importMedia(String(p)));
            return send(res, 200, out);
          }
          case '/api/edit':
            return send(res, 200, await studio.need().apply({ label: String(b.label || 'Edit'), author: 'person', expectedRevision: b.expectedRevision, commands: b.commands }));
          case '/api/undo':
            return send(res, 200, await studio.need().undo());
          case '/api/redo':
            return send(res, 200, await studio.need().redo());
          case '/api/checkpoint':
            return send(res, 200, await studio.need().checkpoint(String(b.label || 'Checkpoint'), 'person'));
          case '/api/restore':
            return send(res, 200, await studio.need().restore(String(b.id)));
          case '/api/playhead':
            studio.playhead = Number(b.t) || 0;
            if (b.selection) studio.selection = { clips: (b.selection.clips ?? []).map(String).slice(0, 50), ...(Array.isArray(b.selection.range) ? { range: b.selection.range.map(Number).slice(0, 2) as [number, number] } : {}) };
            return send(res, 200, { ok: true });
          case '/api/annotate':
            return send(res, 200, await studio.annotate({ t: Number(b.t), range: b.range, clips: (b.clips ?? []).map(String), shapes: b.shapes ?? [], note: String(b.note ?? '').slice(0, 2000) }));
          case '/api/annotation':
            return send(res, 200, studio.need().updateAnnotation(String(b.id), { status: b.status === 'resolved' ? 'resolved' : 'open', ...(b.note !== undefined ? { note: String(b.note) } : {}) }));
          case '/api/agent/send':
            return send(res, 200, await studio.send({ harness: String(b.harness), text: String(b.text ?? ''), annotationIds: b.annotationIds, model: b.model ? String(b.model) : undefined }));
          case '/api/agent/stop':
            studio.stopAgent();
            return send(res, 200, { ok: true });
          case '/api/agent/new':
            studio.newConversation(String(b.harness));
            return send(res, 200, { ok: true });
          case '/api/export':
            return send(res, 200, studio.startExport(b.preset === '4k' ? '4k' : '1080p', Number(b.fps) || 30));
          case '/api/export/cancel':
            studio.cancelExport();
            return send(res, 200, { ok: true });
          case '/api/library/brand':
            return send(res, 200, studio.library.setBrand(b.brand ?? {}));
          case '/api/library/add': {
            const r = studio.library.render(String(b.template), b.params ?? {});
            const s = studio.need();
            const src = `graphics/${String(b.template)}-${Date.now().toString(36).slice(-4)}.html`;
            return send(res, 200, await s.apply({ label: `Add ${r.meta.name}`, author: 'person', graphics: [{ name: src.slice(9, -5), html: r.html, duration: r.duration, template: String(b.template), params: r.params }], commands: [{ op: 'add_clip', src, track: Number(b.track ?? 0), at: Number(b.at ?? 0) }] }));
          }
          case '/api/access':
            studio.need().setAccess({ readRoots: (b.readRoots ?? []).map(String) });
            return send(res, 200, studio.need().access);
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---- the UI's files ----
      if (req.method !== 'GET') return void res.writeHead(405).end();
      const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^[/\\]+/, '');
      const file = join(uiDir, rel);
      if (!file.startsWith(uiDir + sep) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        // the preview is on another 127.0.0.1 port, chosen per project: the UI frames it and plays its sound
        'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*; connect-src 'self'; object-src 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
      });
      res.end(readFileSync(file));
    } catch (e) {
      const err = e as Error & { status?: number };
      send(res, err instanceof StaleRevisionError ? 409 : err.status ?? 400, { error: err.message });
    }
  });
  listening = await listenLocal(server, port);
  studio.origin = `http://127.0.0.1:${listening}`;
  return { url: studio.origin, port: listening, close: () => new Promise<void>((d) => server.close(() => d())) };
}
