import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFilmFile } from 'openfilm/film-doc';
import { ProjectStore, StaleRevisionError } from '../src/core/store.js';
import { Library } from '../src/core/library.js';
import { projectPath } from '../src/core/paths.js';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vs-test-'));
let clipA = '';
let clipB = '';

beforeAll(() => {
  const dir = tmp();
  clipA = join(dir, 'Interview Take 1.mp4');
  clipB = join(dir, 'broll.mp4');
  const mk = (out: string, src: string, d: number) =>
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=30:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  mk(clipA, 'testsrc2', 6);
  mk(clipB, 'smptebars', 4);
});

async function project() {
  const s = ProjectStore.create(join(tmp(), 'p'), 'Test');
  const a = await s.importMedia(clipA);
  const b = await s.importMedia(clipB);
  return { s, a, b };
}

describe('project and media', () => {
  it('imports media read-only, probed, deduplicated', async () => {
    const { s, a } = await project();
    expect(a.src).toBe('media/Interview-Take-1.mp4');
    expect(a.duration).toBeGreaterThan(5.9);
    expect(a.hasAudio).toBe(true);
    expect(statSync(join(s.root, a.src)).mode & 0o222).toBe(0);
    const again = await s.importMedia(clipA);
    expect(again.src).toBe(a.src);
    expect(Object.keys(s.media)).toHaveLength(2);
  });

  it('refuses paths that leave the project or are hidden', async () => {
    const { s } = await project();
    expect(() => projectPath(s.root, '../x')).toThrow();
    expect(() => projectPath(s.root, '/etc/passwd')).toThrow();
    expect(() => projectPath(s.root, '.studio/history.json')).toThrow();
    const outside = tmp();
    mkdirSync(join(s.root, 'graphics'), { recursive: true });
    symlinkSync(outside, join(s.root, 'graphics', 'link'));
    expect(() => projectPath(s.root, 'graphics/link/secret.txt')).toThrow(/leaves/);
  });
});

describe('edits', () => {
  it('applies a batch, writes valid film.html, bumps the revision', async () => {
    const { s, a, b } = await project();
    const r = await s.apply({ label: 'Rough cut', author: 'agent', expectedRevision: 0, commands: [
      { op: 'add_clip', src: a.src, track: 0, at: 0, in: 1, out: 4 },
      { op: 'add_clip', src: b.src, track: 0, at: 3, in: 0, out: 2 },
    ] });
    expect(r.revision).toBe(1);
    const text = readFileSync(join(s.root, 'film.html'), 'utf8');
    expect(readFilmFile(text).problems).toEqual([]);
    expect(s.summary().tracks[0].clips.map((c) => [c.start, c.end])).toEqual([[0, 3], [3, 5]]);
    expect(s.duration()).toBe(5);
  });

  it('rejects overlaps and leaves the film unchanged (all or nothing)', async () => {
    const { s, a, b } = await project();
    await expect(s.apply({ label: 'x', author: 'agent', commands: [
      { op: 'add_clip', src: a.src, track: 0, at: 0, out: 4 },
      { op: 'add_clip', src: b.src, track: 0, at: 2, out: 2 },
    ] })).rejects.toThrow(/overlap/);
    expect(s.revision).toBe(0);
    expect(s.film.tracks[0].clips).toHaveLength(0);
  });

  it('refuses a stale revision', async () => {
    const { s, a } = await project();
    await s.apply({ label: 'one', author: 'person', commands: [{ op: 'add_clip', src: a.src, track: 0, at: 0 }] });
    await expect(s.apply({ label: 'two', author: 'agent', expectedRevision: 0, commands: [{ op: 'remove_clip', id: s.film.tracks[0].clips[0].id }] })).rejects.toBeInstanceOf(StaleRevisionError);
  });

  it('refuses media that is not in the project and outs past the end', async () => {
    const { s, a } = await project();
    await expect(s.apply({ label: 'x', author: 'agent', commands: [{ op: 'add_clip', src: 'media/nope.mp4', track: 0, at: 0, out: 1 }] })).rejects.toThrow(/no such file/);
    await expect(s.apply({ label: 'x', author: 'agent', commands: [{ op: 'add_clip', src: a.src, track: 0, at: 0, out: 99 }] })).rejects.toThrow(/past the end/);
    await expect(s.apply({ label: 'x', author: 'agent', commands: [{ op: 'add_clip', src: '../../etc/passwd', track: 0, at: 0, out: 1 }] })).rejects.toThrow();
  });

  it('splits a clip keeping source timing', async () => {
    const { s, a } = await project();
    await s.apply({ label: 'add', author: 'person', commands: [{ op: 'add_clip', src: a.src, track: 0, at: 1, in: 0.5, out: 5.5, id: 'A', fade: [0.5, 0.5] }] });
    const r = await s.apply({ label: 'split', author: 'person', commands: [{ op: 'split_clip', id: 'A', at: 3 }] });
    const clips = s.summary().tracks[0].clips;
    expect(clips.map((c) => [c.id, c.start, c.end, c.in, c.out])).toEqual([['A', 1, 3, 0.5, 2.5], [r.results[0].newId, 3, 6, 2.5, 5.5]]);
  });

  it('keeps locked tracks away from the agent', async () => {
    const { s, a } = await project();
    await s.apply({ label: 'add', author: 'person', commands: [{ op: 'add_clip', src: a.src, track: 0, at: 0, id: 'A' }, { op: 'set_track', index: 0, locked: true }] });
    await expect(s.apply({ label: 'x', author: 'agent', commands: [{ op: 'remove_clip', id: 'A' }] })).rejects.toThrow(/locked/);
    await expect(s.apply({ label: 'x', author: 'agent', commands: [{ op: 'set_track', index: 0, locked: false }] })).rejects.toThrow(/only the person/);
  });

  it('undoes and redoes, and restores checkpoints as undoable steps', async () => {
    const { s, a, b } = await project();
    await s.apply({ label: 'add A', author: 'person', commands: [{ op: 'add_clip', src: a.src, track: 0, at: 0, id: 'A' }] });
    const cp = await s.checkpoint('before agent', 'system');
    await s.apply({ label: 'agent: add B', author: 'agent', commands: [{ op: 'add_clip', src: b.src, track: 1, at: 0, id: 'B' }] });
    await s.writeGraphic({ name: 'card', html: '<html><head></head><body><script>window.film={duration:2,frame(){}}</script></body></html>', duration: 2, author: 'agent' });
    expect(existsSync(join(s.root, 'graphics/card.html'))).toBe(true);
    await s.restore(cp.id);
    expect(s.film.tracks.flatMap((t) => t.clips.map((c) => c.id))).toEqual(['A']);
    expect(existsSync(join(s.root, 'graphics/card.html'))).toBe(false);
    await s.undo();
    expect(existsSync(join(s.root, 'graphics/card.html'))).toBe(true);
    expect(s.film.tracks.flatMap((t) => t.clips.map((c) => c.id)).sort()).toEqual(['A', 'B']);
    await s.undo();
    await s.undo();
    expect(s.film.tracks.flatMap((t) => t.clips.map((c) => c.id))).toEqual(['A']);
    await s.redo();
    expect(s.film.tracks.flatMap((t) => t.clips.map((c) => c.id)).sort()).toEqual(['A', 'B']);
    // history survives reopening
    const again = ProjectStore.open(s.root);
    expect(again.revision).toBe(s.revision);
    expect(again.history().undo.length).toBe(s.history().undo.length);
  });

  it('refuses graphics that reach the internet or are not pages', async () => {
    const { s } = await project();
    await expect(s.writeGraphic({ name: 'x', html: '<p>hi</p>', duration: 2, author: 'agent' })).rejects.toThrow(/window.film/);
    await expect(s.writeGraphic({ name: 'x', html: '<script src="https://evil.example/x.js"></script><script>window.film={frame(){}}</script>', duration: 2, author: 'agent' })).rejects.toThrow(/internet/);
  });

  it('edits the film styles', async () => {
    const { s } = await project();
    await s.apply({ label: 'css', author: 'agent', commands: [{ op: 'set_styles', css: '@keyframes pop { from { scale: 0.9 } to { scale: 1 } }' }] });
    expect(s.css).toContain('@keyframes pop');
    await expect(s.apply({ label: 'css', author: 'agent', commands: [{ op: 'set_styles', css: '</style><script>x</script>' }] })).rejects.toThrow();
  });
});

describe('library', () => {
  it('fills a template from params and brand, and saves user templates', async () => {
    const user = tmp();
    const lib = new Library(join(__dirname, '..', 'library'), user);
    expect(lib.list().map((t) => t.id)).toContain('lower-third');
    const r = lib.render('lower-third', { name: 'Ada Lovelace', title: 'Analyst', duration: 4 });
    expect(r.html).toContain('"name":"Ada Lovelace"');
    expect(r.html).toContain('"accent":"#ff5a36"');
    expect(r.duration).toBe(4);
    expect(() => lib.render('lower-third', { nope: 1 })).toThrow(/no parameter/);
    lib.setBrand({ accent: '#00aaff' });
    expect(lib.render('lower-third').html).toContain('"accent":"#00aaff"');
    const saved = lib.save({ id: 'ada-card', name: 'Ada card', duration: 4, params: { name: { type: 'text', default: 'Ada' } }, html: r.html });
    expect(saved.source).toBe('user');
    const again = new Library(join(__dirname, '..', 'library'), user);
    expect(again.render('ada-card', { name: 'Grace' }).html).toContain('"name":"Grace"');
    expect(() => lib.save({ id: 'lower-third', name: 'x', duration: 1, html: r.html })).toThrow(/built-in/);
    writeFileSync(join(user, 'x'), '');
  });
});
