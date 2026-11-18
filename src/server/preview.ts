// The preview origin: serves one project's files (film.html played by OpenFilm's timeline, its pages, its media) on
// its own 127.0.0.1 port, so pages written by an agent or a template never share an origin with the app's API. A CSP
// keeps them off the network. The editor talks to the film through postMessage (BRIDGE below).
import { createServer, type Server } from 'node:http';
import { HOST_FLAG, folderFiles, listenLocal } from 'openfilm/host';

const csp = (editorOrigin: string) =>
  [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'none'",
    `frame-ancestors 'self' ${editorOrigin}`,
  ].join('; ');

/** Runs inside the served film.html: answers the editor (and only the editor) by postMessage. */
const BRIDGE = `(() => {
  const EDITOR = __EDITOR__;
  const until = async () => { for (let i = 0; !window.__filmEditor || !window.film; i++) { if (i > 1500) throw new Error('the film did not start'); await new Promise((r) => setTimeout(r, 20)); } };
  const plain = (o) => o == null ? o : JSON.parse(JSON.stringify(o, (k, v) => (typeof Node !== 'undefined' && v instanceof Node) || v === window ? undefined : v));
  const facts = () => ({ duration: window.film.duration, spans: window.__filmSpans(), sounds: window.__filmSounds() });
  addEventListener('message', async (e) => {
    if (e.origin !== EDITOR || !e.data || typeof e.data.op !== 'string') return;
    const { id, op, args = {} } = e.data;
    try {
      await until();
      let result = null;
      if (op === 'ready') { const r = window.film.ready; await (typeof r === 'function' ? r() : r); result = facts(); }
      else if (op === 'facts') result = facts();
      else if (op === 'watch') await window.__filmEditor.watch(Number(args.t) || 0, args.play || null);
      else if (op === 'update') result = await window.__filmEditor.update(args.value);
      else if (op === 'pick') result = window.__filmEditor.pick(Number(args.x), Number(args.y));
      e.source.postMessage({ id, ok: true, result: plain(result) }, EDITOR);
    } catch (err) {
      e.source.postMessage({ id, ok: false, error: String((err && err.message) || err) }, EDITOR);
    }
  });
  addEventListener('error', (e) => parent.postMessage({ type: 'film-error', message: String(e.message) }, EDITOR));
})();`;

export type PreviewServer = { origin: string; root: string; close(): Promise<void> };

export async function startPreview(root: string, editorOrigin: () => string): Promise<PreviewServer> {
  const files = folderFiles(root, {
    timelineInject: `<script>${HOST_FLAG}</script><script>${BRIDGE.replace('__EDITOR__', JSON.stringify(editorOrigin()))}</script>`,
    headers: { 'content-security-policy': csp(editorOrigin()), 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': editorOrigin() },
  });
  let port = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return void res.writeHead(421).end('wrong host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return void res.writeHead(400).end();
    }
    // the editor's own folder and any other hidden file stay private
    if (!path.includes('/__film/') && path.split('/').some((p) => p.startsWith('.'))) return void res.writeHead(404).end('not found');
    if (!files(req, res, url.pathname, url.searchParams)) res.writeHead(403).end();
  });
  port = await listenLocal(server, 0);
  return {
    origin: `http://127.0.0.1:${port}`,
    root,
    // a browser keeps connections open (media, keep-alive): drop them, and never wait long for the rest
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
        setTimeout(done, 1000);
      }),
  };
}
