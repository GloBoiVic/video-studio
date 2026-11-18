// The local servers' guards, without Electron: tokens, host checks, the preview origin's privacy and CSP.
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Studio } from '../src/server/studio.js';
import { startApi } from '../src/server/api.js';
import { callTool, toolList } from '../src/server/tools.js';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vs-srv-'));
let studio: Studio;
let api: { url: string; port: number; close(): Promise<void> };
const token = 'test-token-0123456789';
const call = (path: string, init: RequestInit & { tok?: string } = {}) =>
  fetch(`${api.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.tok !== undefined ? { 'x-studio-token': init.tok } : { 'x-studio-token': token }), ...(init.headers ?? {}) } });

beforeAll(async () => {
  const home = tmp();
  mkdirSync(join(home, 'projects'));
  studio = new Studio({ libraryDir: join(__dirname, '..', 'library'), userDir: join(home, 'user'), projectsDir: join(home, 'projects'), host: null, mcp: { command: 'node', args: [] } });
  api = await startApi(studio, { uiDir: join(home, 'ui'), token });
  const clip = join(home, 'a.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  await studio.create('Server test');
  await studio.need().importMedia(clip);
});
afterAll(async () => {
  await studio.close();
  await api.close();
});

describe('app API', () => {
  it('needs the launch token', async () => {
    expect((await call('/api/state', { tok: '' })).status).toBe(401);
    expect((await call('/api/state', { tok: 'wrong-token-0123456789' })).status).toBe(401);
    expect((await call('/api/state')).status).toBe(200);
  });

  it('answers only its own host name (DNS rebinding)', async () => {
    // fetch drops a custom Host header, so ask with node:http
    const status = await new Promise<number>((done) => {
      request({ host: '127.0.0.1', port: api.port, path: '/api/state', headers: { 'x-studio-token': token, host: 'evil.example' } }, (res) => done(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(421);
  });

  it('refuses agent calls outside a running turn', async () => {
    const r = await fetch(`${api.url}/agent/call`, { method: 'POST', headers: { 'x-agent-token': '' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('edits through the store with revision checks (409 on stale)', async () => {
    const src = Object.keys(studio.need().media)[0];
    const ok = await call('/api/edit', { method: 'POST', body: JSON.stringify({ label: 'add', expectedRevision: 0, commands: [{ op: 'add_clip', src, track: 0, at: 0 }] }) });
    expect(ok.status).toBe(200);
    const stale = await call('/api/edit', { method: 'POST', body: JSON.stringify({ label: 'add', expectedRevision: 0, commands: [{ op: 'add_track' }] }) });
    expect(stale.status).toBe(409);
  });
});

describe('preview origin', () => {
  it('serves the film with the host flag, the bridge and a no-network CSP', async () => {
    const r = await fetch(`${studio.previewOrigin()}/film.html`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("window.filmHost={version:'0.1'");
    expect(html).toContain(JSON.stringify(studio.origin));
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self' data: blob:");
  });

  it('keeps the editor folder and hidden files private', async () => {
    expect((await fetch(`${studio.previewOrigin()}/.studio/history.json`)).status).toBe(404);
    expect((await fetch(`${studio.previewOrigin()}/%2Estudio/project.json`)).status).toBe(404);
    expect((await fetch(`${studio.previewOrigin()}/../../etc/passwd`)).status).not.toBe(200);
  });
});

describe('agent tools', () => {
  it('lists JSON schemas for every tool', () => {
    const list = toolList();
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['get_project', 'apply_edits', 'look', 'get_annotations', 'write_graphic', 'save_template']));
    for (const t of list) expect(t.inputSchema.type).toBe('object');
  });

  it('rejects bad arguments and unknown tools as tool errors', async () => {
    expect((await callTool('apply_edits', { label: 'x' }, studio)).isError).toBe(true);
    expect((await callTool('nope', {}, studio)).isError).toBe(true);
  });

  it('refuses imports outside the allowed read roots', async () => {
    const r = await callTool('import_media', { path: '/etc/hosts' }, studio);
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/not allowed/) });
  });

  it('places a template graphic in one step', async () => {
    const s = studio.need();
    const r = await callTool('add_template_graphic', { template: 'lower-third', params: { name: 'Test' }, track: 1, at: 0, expected_revision: s.revision }, studio);
    expect(r.isError).toBeFalsy();
    expect(s.summary().tracks[1].clips[0].src).toMatch(/^graphics\/lower-third-/);
  });
});

describe('agent models', () => {
  it('lists Codex models from its cache (hidden ones left out) and accepts only model-like names', async () => {
    const { codex, claude, MODEL_ID } = await import('../src/server/agents.js');
    const home = tmp();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'model-b', display_name: 'Model B', visibility: 'list', priority: 2 },
      { slug: 'model-a', display_name: 'Model A', visibility: 'list', priority: 1 },
      { slug: 'secret', visibility: 'hide', priority: 0 },
      { slug: '--evil flag', visibility: 'list', priority: 3 },
    ] }));
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(await codex.models()).toEqual([{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }]);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
    expect((await claude.models()).map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    for (const ok of ['sonnet', 'gpt-6.2-sol', 'claude-opus-5-5', 'org/model:tag']) expect(MODEL_ID.test(ok)).toBe(true);
    for (const bad of ['', '--help', 'a b', 'x;rm -rf /', '-m']) expect(MODEL_ID.test(bad)).toBe(false);
  });
});
