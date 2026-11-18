// The project store: the single writer of a project. Every change (the person's in the timeline, the agent's
// through its tools, an undo) goes through this queue, is checked, written atomically, given a new revision and
// recorded as one undo step with its author. Agents pass the revision they read; a stale one is refused.
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { filmHtml, readFilmFile } from 'openfilm/film-doc';
import { applyCommands, clipLength, filmLength, type Command } from './commands.js';
import { FILM, GRAPHICS_DIR, MEDIA_DIR, EXPORTS_DIR, STUDIO_DIR, projectPath, safeName, isInside } from './paths.js';
import { kindOfExt, probe, sha256File } from './media.js';
import type { Annotation, Author, Checkpoint, Film, GraphicInfo, HistoryEntry, MediaInfo, Shape } from './types.js';

type Snap = { film: string; graphics: Record<string, string | null> };
type Step = HistoryEntry & { before: Snap; after: Snap };

export type GraphicWrite = { name: string; html: string; duration: number | null; template?: string; params?: Record<string, unknown> };
export type Batch = { label: string; author: Author; expectedRevision?: number; commands?: Command[]; graphics?: GraphicWrite[] };
export type ProjectMeta = { name: string; createdAt: string; format: 'openfilm-0.1'; app: 'video-studio'; version: 1 };
export type Access = { readRoots: string[] };

const MAX_STEPS = 300;
const MAX_GRAPHIC_BYTES = 512 * 1024;

export class StaleRevisionError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`the film changed since you read it (you had revision ${expected}, it is now ${actual}). Read the project again and redo your edit on top of the current state.`);
  }
}

function atomicWrite(file: string, data: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const STYLE = /(<head\b[^>]*>[\s\S]*?<style\b[^>]*>)([\s\S]*?)(<\/style>)/i;

export function newFilmHtml(name: string, w = 1920, h = 1080) {
  const title = name.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<title>${title}</title>
<style>
</style>
</head>
<body>
<section>
</section>
</body>
</html>
`;
}

export class ProjectStore extends EventEmitter {
  readonly root: string;
  meta!: ProjectMeta;
  text = '';
  film!: Film;
  revision = 0;
  media: Record<string, MediaInfo> = {};
  graphics: Record<string, GraphicInfo> = {};
  annotations: Annotation[] = [];
  checkpoints: Checkpoint[] = [];
  access: Access = { readRoots: [] };
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  /** Create a new project folder (it must not exist or be empty). */
  static create(root: string, name: string, stage = { w: 1920, h: 1080 }): ProjectStore {
    const abs = resolve(root);
    if (existsSync(abs) && readdirSync(abs).length) throw new Error(`folder is not empty: ${abs}`);
    for (const d of [MEDIA_DIR, GRAPHICS_DIR, EXPORTS_DIR, join(STUDIO_DIR, 'annotations'), join(STUDIO_DIR, 'checkpoints')]) mkdirSync(join(abs, d), { recursive: true });
    atomicWrite(join(abs, FILM), newFilmHtml(name, stage.w, stage.h));
    const meta: ProjectMeta = { name, createdAt: new Date().toISOString(), format: 'openfilm-0.1', app: 'video-studio', version: 1 };
    atomicWrite(join(abs, STUDIO_DIR, 'project.json'), JSON.stringify(meta, null, 2));
    atomicWrite(join(abs, STUDIO_DIR, 'access.json'), JSON.stringify({ readRoots: [] }, null, 2));
    atomicWrite(join(abs, '.gitignore'), 'exports/\n.studio/cache/\n');
    return ProjectStore.open(abs);
  }

  static open(root: string): ProjectStore {
    const s = new ProjectStore(root);
    if (!existsSync(join(s.root, FILM))) throw new Error(`not a project (no film.html): ${s.root}`);
    s.meta = readJson(s.p('project.json'), { name: basename(s.root), createdAt: new Date().toISOString(), format: 'openfilm-0.1', app: 'video-studio', version: 1 } as ProjectMeta);
    s.media = readJson(s.p('media.json'), {});
    s.graphics = readJson(s.p('graphics.json'), {});
    s.annotations = readJson(s.p('annotations.json'), []);
    s.checkpoints = readJson(s.p('checkpoints.json'), []);
    s.access = readJson(s.p('access.json'), { readRoots: [] });
    const h = readJson<{ undo: Step[]; redo: Step[]; revision: number }>(s.p('history.json'), { undo: [], redo: [], revision: 0 });
    s.undoStack = h.undo;
    s.redoStack = h.redo;
    s.revision = h.revision;
    s.load(readFileSync(join(s.root, FILM), 'utf8'));
    return s;
  }

  private p(...parts: string[]) {
    return join(this.root, STUDIO_DIR, ...parts);
  }

  private load(text: string) {
    const r = readFilmFile(text);
    if (!r.value) throw new Error(`film.html has problems:\n${r.problems.join('\n')}`);
    this.text = text;
    this.film = r.value as unknown as Film;
  }

  get css(): string {
    return STYLE.exec(this.text)?.[2] ?? '';
  }

  /** Run `fn` alone: one write at a time, in order. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---- reading ----

  lengthOf = (src: string): number | null => {
    if (this.media[src]) return this.media[src].kind === 'still' ? null : this.media[src].duration;
    if (this.graphics[src]) return this.graphics[src].duration;
    return null;
  };
  exists = (src: string): boolean => {
    try {
      if (!src.startsWith(`${MEDIA_DIR}/`) && !src.startsWith(`${GRAPHICS_DIR}/`)) return false;
      return existsSync(projectPath(this.root, src));
    } catch {
      return false;
    }
  };
  isStill = (src: string) => kindOfExt(extname(src)) === 'still';
  private ctx(author: Author) {
    return { author, lengthOf: this.lengthOf, exists: this.exists, isStill: this.isStill };
  }

  duration(): number {
    return filmLength(this.film, this.ctx('system'));
  }

  /** The timeline as plain data: tracks, clips with computed start/end. */
  summary() {
    const ctx = this.ctx('system');
    return {
      name: this.meta.name,
      revision: this.revision,
      stage: this.film.stage,
      duration: this.duration(),
      tracks: this.film.tracks.map((t, index) => ({
        index,
        locked: !!t.locked,
        hidden: !!t.hidden,
        muted: !!t.muted,
        clips: t.clips.map((c) => {
          const len = clipLength(c, ctx);
          const at = c.at ?? 0;
          return {
            id: c.id,
            src: c.src,
            kind: this.media[c.src]?.kind ?? (c.src.endsWith('.html') ? 'graphic' : kindOfExt(extname(c.src))),
            start: at,
            end: len == null ? null : Math.round((at + len) * 1000) / 1000,
            in: c.time?.[0] ?? 0,
            out: c.time?.[1] ?? this.lengthOf(c.src),
            ...(c.speed ? { speed: c.speed } : {}),
            ...(c.volume !== undefined ? { volume: c.volume } : {}),
            ...(c.box ? { box: c.box } : {}),
            ...(c.style ? { style: c.style } : {}),
            ...(c.class ? { class: c.class } : {}),
            ...(c.disabled ? { disabled: true } : {}),
            ...(c.overrides ? { overrides: c.overrides } : {}),
          };
        }),
      })),
      styles: this.css,
    };
  }

  history() {
    return {
      undo: this.undoStack.map(({ revision, label, author, at }) => ({ revision, label, author, at })),
      redo: this.redoStack.map(({ revision, label, author, at }) => ({ revision, label, author, at })),
    };
  }

  // ---- writing ----

  private snapGraphics(srcs: Iterable<string>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const src of srcs) {
      const f = projectPath(this.root, src);
      out[src] = existsSync(f) ? readFileSync(f, 'utf8') : null;
    }
    return out;
  }

  private writeSnap(s: Snap) {
    for (const [src, html] of Object.entries(s.graphics)) {
      const f = projectPath(this.root, src);
      if (html == null) rmSync(f, { force: true });
      else atomicWrite(f, html);
    }
    this.load(s.film);
    atomicWrite(join(this.root, FILM), s.film);
  }

  private persist() {
    atomicWrite(this.p('history.json'), JSON.stringify({ revision: this.revision, undo: this.undoStack.slice(-MAX_STEPS), redo: this.redoStack.slice(-MAX_STEPS) }));
    atomicWrite(this.p('graphics.json'), JSON.stringify(this.graphics, null, 2));
  }

  private commit(label: string, author: Author, before: Snap, after: Snap, extra: Record<string, unknown> = {}) {
    this.writeSnap(after);
    this.revision += 1;
    const step: Step = { revision: this.revision, label, author, at: new Date().toISOString(), before, after };
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
    this.redoStack = [];
    this.persist();
    appendFileSync(this.p('journal.jsonl'), JSON.stringify({ revision: this.revision, label, author, at: step.at, ...extra }) + '\n');
    this.emit('change', { revision: this.revision, label, author, graphics: Object.keys(after.graphics) });
  }

  private checkRevision(expected: number | undefined) {
    if (expected !== undefined && expected !== this.revision) throw new StaleRevisionError(expected, this.revision);
  }

  /** Check a graphic page before it is written. Pages run in the preview's isolated origin with no network. */
  private checkGraphic(g: GraphicWrite): GraphicInfo & { html: string } {
    const html = g.html;
    if (typeof html !== 'string' || !html) throw new Error('graphic html is empty');
    if (Buffer.byteLength(html) > MAX_GRAPHIC_BYTES) throw new Error('graphic is larger than 512 KB');
    if (!/window\.film\s*=/.test(html)) throw new Error('a graphic page must set window.film = { frame(t) {...}, duration } (see the OpenFilm page protocol)');
    if (/(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) || /@import\s+url\(\s*["']?(?:https?:)?\/\//i.test(html) || /url\(\s*["']?https?:/i.test(html)) {
      throw new Error('graphics may not load anything from the internet: inline fonts, images and scripts, or use project files');
    }
    if (g.duration !== null && !(g.duration > 0 && g.duration <= 3600)) throw new Error('duration must be between 0 and 3600 seconds, or null');
    const src = `${GRAPHICS_DIR}/${safeName(g.name.replace(/\.html?$/i, ''), 'graphic')}.html`;
    return { src, html, duration: g.duration, ...(g.template ? { template: g.template } : {}), ...(g.params ? { params: g.params } : {}) };
  }

  /**
   * Apply a batch: graphic pages to write, then timeline commands, checked together and kept as one step (one
   * undo), or refused whole. `expectedRevision` (agents always send it) refuses a batch made from a stale read.
   */
  apply(batch: Batch) {
    return this.exclusive(() => {
      this.checkRevision(batch.expectedRevision);
      const commands = batch.commands ?? [];
      const writes = (batch.graphics ?? []).map((g) => this.checkGraphic(g));
      if (!commands.length && !writes.length) throw new Error('nothing to do: no commands and no graphics');
      const pending = new Map(writes.map((w) => [w.src, w]));
      const ctx = {
        ...this.ctx(batch.author),
        exists: (src: string) => pending.has(src) || this.exists(src),
        lengthOf: (src: string) => (pending.has(src) ? pending.get(src)!.duration : this.lengthOf(src)),
      };
      let text = this.text;
      let results: Array<Record<string, unknown>> = [];
      if (commands.length) {
        const r = applyCommands(this.film, this.css, commands, ctx);
        results = r.results;
        let before = this.text;
        if (r.css !== null && r.css !== this.css) before = before.replace(STYLE, (_, a, _b, c) => `${a}\n${r.css!.trim()}\n${c}`);
        text = filmHtml(r.film, before);
        const check = readFilmFile(text);
        if (!check.doc) throw new Error(`the edit would make film.html invalid:\n${check.problems.join('\n')}`);
      }
      const before: Snap = { film: this.text, graphics: this.snapGraphics(pending.keys()) };
      const after: Snap = { film: text, graphics: Object.fromEntries(writes.map((w) => [w.src, w.html])) };
      for (const { html: _h, ...info } of writes) this.graphics[info.src] = info;
      this.commit(batch.label || 'Edit', batch.author, before, after, { commands, graphics: [...pending.keys()] });
      return { revision: this.revision, results, graphics: writes.map((w) => ({ src: w.src, duration: w.duration })) };
    });
  }

  /** Write one graphic page (graphics/<name>.html) as its own step. */
  async writeGraphic(opts: GraphicWrite & { author: Author; label?: string; expectedRevision?: number }) {
    const r = await this.apply({ label: opts.label ?? `Write graphic ${opts.name}`, author: opts.author, expectedRevision: opts.expectedRevision, graphics: [opts] });
    return { src: r.graphics[0].src, revision: r.revision, duration: r.graphics[0].duration };
  }

  undo(author: Author = 'person') {
    return this.exclusive(() => {
      const step = this.undoStack.pop();
      if (!step) return { revision: this.revision, undone: null };
      this.writeSnap(step.before);
      this.redoStack.push(step);
      this.revision += 1;
      this.persist();
      appendFileSync(this.p('journal.jsonl'), JSON.stringify({ revision: this.revision, label: `Undo: ${step.label}`, author, at: new Date().toISOString() }) + '\n');
      this.emit('change', { revision: this.revision, label: `Undo: ${step.label}`, author, graphics: Object.keys(step.before.graphics) });
      return { revision: this.revision, undone: step.label };
    });
  }

  redo(author: Author = 'person') {
    return this.exclusive(() => {
      const step = this.redoStack.pop();
      if (!step) return { revision: this.revision, redone: null };
      this.writeSnap(step.after);
      this.undoStack.push(step);
      this.revision += 1;
      this.persist();
      this.emit('change', { revision: this.revision, label: `Redo: ${step.label}`, author, graphics: Object.keys(step.after.graphics) });
      return { revision: this.revision, redone: step.label };
    });
  }

  // ---- checkpoints: whole-project snapshots of the edit (film.html and graphics), never of media ----

  private allGraphics(): Record<string, string | null> {
    const dir = join(this.root, GRAPHICS_DIR);
    if (!existsSync(dir)) return {};
    return this.snapGraphics(readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => `${GRAPHICS_DIR}/${f}`));
  }

  checkpoint(label: string, author: Author) {
    return this.exclusive(() => {
      const id = `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const cp: Checkpoint = { id, label, revision: this.revision, at: new Date().toISOString(), author };
      atomicWrite(this.p('checkpoints', `${id}.json`), JSON.stringify({ ...cp, film: this.text, graphics: this.allGraphics(), graphicsMeta: this.graphics }));
      this.checkpoints.push(cp);
      atomicWrite(this.p('checkpoints.json'), JSON.stringify(this.checkpoints, null, 2));
      this.emit('checkpoint', cp);
      return cp;
    });
  }

  /** Bring the edit back to a checkpoint, as one undoable step. */
  restore(id: string, author: Author = 'person') {
    return this.exclusive(() => {
      const cp = this.checkpoints.find((c) => c.id === id);
      if (!cp) throw new Error(`no checkpoint ${id}`);
      const saved = JSON.parse(readFileSync(this.p('checkpoints', `${id}.json`), 'utf8')) as { film: string; graphics: Record<string, string>; graphicsMeta: Record<string, GraphicInfo> };
      const now = this.allGraphics();
      const srcs = new Set([...Object.keys(now), ...Object.keys(saved.graphics)]);
      const after: Snap = { film: saved.film, graphics: Object.fromEntries([...srcs].map((s) => [s, saved.graphics[s] ?? null])) };
      const before: Snap = { film: this.text, graphics: Object.fromEntries([...srcs].map((s) => [s, now[s] ?? null])) };
      this.graphics = { ...this.graphics, ...saved.graphicsMeta };
      this.commit(`Back to: ${cp.label}`, author, before, after, { checkpoint: id });
      return { revision: this.revision };
    });
  }

  // ---- media: copied in, made read-only, never written again ----

  importMedia(file: string, { from = 'person' }: { from?: string } = {}) {
    return this.exclusive(async () => {
      const abs = resolve(file);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${abs}`);
      const kind = kindOfExt(extname(abs));
      if (!kind) throw new Error(`not a supported media file: ${basename(abs)}`);
      if (st.size > 50 * 1024 ** 3) throw new Error('file is larger than 50 GB');
      const sha = await sha256File(abs);
      const existing = Object.values(this.media).find((m) => m.sha256 === sha);
      if (existing) return existing;
      const info = kind === 'still' ? { duration: null, hasAudio: false, width: undefined, height: undefined } : await probe(abs);
      if (kind === 'video' && !('hasVideo' in info && info.hasVideo)) throw new Error(`${basename(abs)} has no video stream`);
      const stem = safeName(basename(abs, extname(abs)), 'media');
      let name = `${stem}${extname(abs).toLowerCase()}`;
      for (let n = 2; existsSync(join(this.root, MEDIA_DIR, name)); n++) name = `${stem}-${n}${extname(abs).toLowerCase()}`;
      const dest = join(this.root, MEDIA_DIR, name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      chmodSync(dest, 0o444);
      const m: MediaInfo = {
        src: `${MEDIA_DIR}/${name}`,
        kind,
        duration: info.duration,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        hasAudio: !!info.hasAudio,
        sha256: sha,
        importedFrom: from === 'person' ? abs : `${from}:${abs}`,
        importedAt: new Date().toISOString(),
      };
      this.media[m.src] = m;
      atomicWrite(this.p('media.json'), JSON.stringify(this.media, null, 2));
      this.emit('media', m);
      return m;
    });
  }

  /** Whether a path outside the project may be read (imported from) by the agent: inside a configured read root. */
  agentMayRead(abs: string): boolean {
    return this.access.readRoots.some((r) => isInside(r, abs));
  }

  setAccess(access: Access) {
    this.access = { readRoots: access.readRoots.map((r) => resolve(r)) };
    atomicWrite(this.p('access.json'), JSON.stringify(this.access, null, 2));
  }

  // ---- annotations ----

  addAnnotation(a: { t: number; range?: [number, number]; clips: string[]; shapes: Shape[]; note: string }): Annotation {
    const ann: Annotation = { id: `a${this.annotations.length + 1}-${randomUUID().slice(0, 4)}`, ...a, status: 'open', createdAt: new Date().toISOString() };
    this.annotations.push(ann);
    this.saveAnnotations();
    return ann;
  }
  updateAnnotation(id: string, patch: Partial<Pick<Annotation, 'status' | 'resolution' | 'note' | 'image'>>) {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) throw new Error(`no annotation ${id}`);
    Object.assign(a, patch);
    this.saveAnnotations();
    return a;
  }
  saveAnnotationImage(id: string, png: Buffer) {
    const rel = `${STUDIO_DIR}/annotations/${id}.png`;
    atomicWrite(join(this.root, rel), png);
    return this.updateAnnotation(id, { image: rel });
  }
  private saveAnnotations() {
    atomicWrite(this.p('annotations.json'), JSON.stringify(this.annotations, null, 2));
    this.emit('annotations', this.annotations);
  }
}
