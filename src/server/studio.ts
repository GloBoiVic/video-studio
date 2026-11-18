// The app's state on the Node side: the open project, its preview origin, the library, the agent conversation and
// exports. The HTTP API (api.ts) and the agent tools (tools.ts) both act through this.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ProjectStore } from '../core/store.js';
import { Library } from '../core/library.js';
import { STUDIO_DIR, EXPORTS_DIR, safeName } from '../core/paths.js';
import type { Shape } from '../core/types.js';
import { startPreview, type PreviewServer } from './preview.js';
import { HARNESSES, MODEL_ID, type AgentEvent, type AgentRun, type McpLaunch } from './agents.js';
import { AGENT_INSTRUCTIONS } from './instructions.js';
import { annotationImage, exportFilm, type FrameHost } from './render.js';
import type { ToolResult } from './tools.js';

export type ChatMessage = {
  id: string;
  role: 'person' | 'agent' | 'system';
  harness?: string;
  model?: string;
  text: string;
  at: string;
  status?: 'running' | 'done' | 'error' | 'stopped';
  checkpointId?: string;
  annotationIds?: string[];
  tools?: Array<{ name: string; summary?: string; ok?: boolean }>;
  cost?: number;
};

export type StudioOptions = {
  libraryDir: string;
  userDir: string;
  projectsDir: string;
  host: FrameHost | null;
  /** how to start the MCP server process (command + args); env is added per turn */
  mcp: { command: string; args: string[]; env?: Record<string, string> };
};

export type ExportJob = { id: string; preset: string; status: 'running' | 'done' | 'error'; frame: number; frames: number; phase: string; out?: string; error?: string; startedAt: string; seconds?: number; probe?: unknown };

export class Studio extends EventEmitter {
  store: ProjectStore | null = null;
  preview: PreviewServer | null = null;
  library: Library;
  origin = '';
  playhead = 0;
  selection: { clips: string[]; range?: [number, number] } = { clips: [] };
  chat: ChatMessage[] = [];
  run: AgentRun | null = null;
  agentToken = '';
  exports: ExportJob[] = [];
  private exportAbort: AbortController | null = null;

  constructor(readonly opts: StudioOptions) {
    super();
    this.library = new Library(opts.libraryDir, join(opts.userDir, 'library'));
    mkdirSync(opts.userDir, { recursive: true });
  }

  push(type: string, data: unknown) {
    this.emit('push', { type, data });
  }

  need(): ProjectStore {
    if (!this.store) throw new Error('no project is open');
    return this.store;
  }
  requireHost(): FrameHost {
    if (!this.opts.host) throw new Error('drawing frames needs the desktop app (no frame host in this process)');
    return this.opts.host;
  }
  previewOrigin(): string {
    if (!this.preview) throw new Error('no project is open');
    return this.preview.origin;
  }

  // ---- projects ----

  recent(): Array<{ path: string; name: string; openedAt: string }> {
    try {
      return (JSON.parse(readFileSync(join(this.opts.userDir, 'recent.json'), 'utf8')) as Array<{ path: string; name: string; openedAt: string }>).filter((r) => existsSync(join(r.path, 'film.html')));
    } catch {
      return [];
    }
  }

  async create(name: string, parent?: string) {
    const dir = resolve(parent ?? this.opts.projectsDir, safeName(name, 'Untitled'));
    if (existsSync(dir)) throw new Error(`a project folder already exists: ${dir}`);
    ProjectStore.create(dir, name);
    return this.open(dir);
  }

  async open(dir: string) {
    if (this.run && !this.run.finished) throw new Error('stop the agent before switching projects');
    const store = ProjectStore.open(dir);
    await this.close();
    this.store = store;
    this.preview = await startPreview(store.root, () => this.origin);
    this.chat = this.readChat();
    store.on('change', (c) => this.push('change', { ...c, project: this.state() }));
    store.on('annotations', (a) => this.push('annotations', a));
    store.on('media', () => this.push('media', Object.values(store.media)));
    store.on('checkpoint', () => this.push('checkpoints', store.checkpoints));
    const recent = [{ path: store.root, name: store.meta.name, openedAt: new Date().toISOString() }, ...this.recent().filter((r) => r.path !== store.root)].slice(0, 12);
    writeFileSync(join(this.opts.userDir, 'recent.json'), JSON.stringify(recent, null, 2));
    this.push('project', this.state());
    return this.state();
  }

  async close() {
    await this.preview?.close().catch(() => undefined);
    this.preview = null;
    this.store?.removeAllListeners();
    this.store = null;
  }

  projectInstructions(): string {
    try {
      return readFileSync(join(this.need().root, STUDIO_DIR, 'instructions.md'), 'utf8').slice(0, 20_000);
    } catch {
      return '';
    }
  }

  state() {
    const s = this.store;
    return {
      project: s
        ? {
            root: s.root,
            ...s.summary(),
            film: s.film,
            media: Object.values(s.media),
            graphics: Object.values(s.graphics),
            history: s.history(),
            checkpoints: s.checkpoints,
            annotations: s.annotations,
            access: s.access,
            previewOrigin: this.preview?.origin,
          }
        : null,
      chat: this.chat,
      agentRunning: !!(this.run && !this.run.finished),
      exports: this.exports,
      library: this.library.list(),
      brand: this.library.brand(),
      recent: this.recent(),
      canRender: !!this.opts.host,
    };
  }

  // ---- graphics ----

  async placeGraphic(o: { name: string; html: string; duration: number | null; place?: { track: number; at: number; box?: { x: number; y: number; w?: number; h?: number; r?: number } }; expectedRevision?: number; label: string; template?: string; params?: Record<string, unknown> }): Promise<ToolResult> {
    const s = this.need();
    const src = `graphics/${safeName(o.name.replace(/\.html?$/i, ''), 'graphic')}.html`;
    const r = await s.apply({
      label: o.label,
      author: 'agent',
      expectedRevision: o.expectedRevision,
      graphics: [{ name: o.name, html: o.html, duration: o.duration, template: o.template, params: o.params }],
      commands: o.place ? [{ op: 'add_clip', src, track: o.place.track, at: o.place.at, ...(o.duration == null ? { out: 5 } : {}), ...(o.place.box ? { box: o.place.box } : {}) }] : [],
    });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }

  // ---- annotations ----

  async annotate(a: { t: number; range?: [number, number]; clips: string[]; shapes: Shape[]; note: string }) {
    const s = this.need();
    const ann = s.addAnnotation(a);
    if (this.opts.host) {
      try {
        const png = await annotationImage(this.opts.host, this.previewOrigin(), s.film.stage, a.t, a.shapes, a.note);
        return s.saveAnnotationImage(ann.id, png);
      } catch (e) {
        this.push('toast', { kind: 'error', text: `Could not draw the annotation image: ${(e as Error).message}` });
      }
    }
    return ann;
  }

  // ---- the agent ----

  private chatFile() {
    return join(this.need().root, STUDIO_DIR, 'chat.json');
  }
  private readChat(): ChatMessage[] {
    try {
      return JSON.parse(readFileSync(this.chatFile(), 'utf8'));
    } catch {
      return [];
    }
  }
  private saveChat() {
    writeFileSync(this.chatFile(), JSON.stringify(this.chat.slice(-500), null, 1));
    this.push('chat', this.chat);
  }
  private sessions(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(join(this.need().root, STUDIO_DIR, 'agents.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  private saveSession(harness: string, id: string) {
    writeFileSync(join(this.need().root, STUDIO_DIR, 'agents.json'), JSON.stringify({ ...this.sessions(), [harness]: id }, null, 2));
  }
  newConversation(harness: string) {
    const all = this.sessions();
    delete all[harness];
    writeFileSync(join(this.need().root, STUDIO_DIR, 'agents.json'), JSON.stringify(all, null, 2));
    this.chat.push({ id: randomUUID(), role: 'system', text: 'New conversation: the agent starts fresh (the film is unchanged).', at: new Date().toISOString() });
    this.saveChat();
  }

  async harnesses() {
    return Promise.all(Object.values(HARNESSES).map(async (h) => ({ id: h.id, label: h.label, ...(await h.detect()), models: await h.models() })));
  }

  async send(o: { harness: string; text: string; annotationIds?: string[]; model?: string }) {
    const s = this.need();
    if (this.run && !this.run.finished) throw new Error('the agent is still working: stop it or wait');
    const h = HARNESSES[o.harness];
    if (!h) throw new Error(`unknown agent ${o.harness}`);
    const d = await h.detect();
    if (!d.available) throw new Error(d.why ?? `${h.label} is not available`);
    const text = o.text.trim();
    if (!text) throw new Error('say something');
    const model = o.model?.trim() || undefined;
    if (model && !MODEL_ID.test(model)) throw new Error(`not a model name: ${model}`);

    const cp = await s.checkpoint(`Before: ${text.slice(0, 60)}`, 'system');
    const anns = (o.annotationIds ?? []).map((id) => s.annotations.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
    this.chat.push({ id: randomUUID(), role: 'person', text, at: new Date().toISOString(), checkpointId: cp.id, annotationIds: anns.map((a) => a.id) });
    const reply: ChatMessage = { id: randomUUID(), role: 'agent', harness: h.id, ...(model ? { model } : {}), text: '', at: new Date().toISOString(), status: 'running', tools: [], checkpointId: cp.id };
    this.chat.push(reply);
    this.saveChat();

    const context = [
      `[Video Studio] project "${s.meta.name}", revision ${s.revision}, ${s.duration()} s long, playhead at ${this.playhead.toFixed(2)} s.`,
      this.selection.clips.length ? `Selected clips: ${this.selection.clips.join(', ')}.` : '',
      this.selection.range ? `Selected range: ${this.selection.range[0].toFixed(2)}–${this.selection.range[1].toFixed(2)} s.` : '',
      anns.length ? `Attached annotations (see them with get_annotations): ${anns.map((a) => `${a.id} at ${a.t.toFixed(2)} s "${a.note}"`).join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    this.agentToken = randomBytes(24).toString('hex');
    const mcp: McpLaunch = { command: this.opts.mcp.command, args: this.opts.mcp.args, env: { ...(this.opts.mcp.env ?? {}), STUDIO_API: this.origin, STUDIO_AGENT_TOKEN: this.agentToken } };
    const extra = this.projectInstructions();
    const run = h.run({
      prompt: `${context}\n\n${text}`,
      cwd: s.root,
      instructions: extra ? `${AGENT_INSTRUCTIONS}\n\nProject instructions from the person:\n${extra}` : AGENT_INSTRUCTIONS,
      mcp,
      sessionId: this.sessions()[h.id],
      readDirs: s.access.readRoots,
      model,
    });
    this.run = run;
    this.push('agent', { running: true });
    run.on('event', (e: AgentEvent) => {
      if (e.kind === 'session') this.saveSession(h.id, e.id);
      else if (e.kind === 'text') reply.text = reply.text ? `${reply.text}\n\n${e.text}` : e.text;
      else if (e.kind === 'tool') reply.tools!.push({ name: e.name });
      else if (e.kind === 'error') reply.text += `${reply.text ? '\n\n' : ''}⚠️ ${e.text}`;
      else if (e.kind === 'done') {
        reply.status = e.ok ? 'done' : e.text === 'Stopped.' ? 'stopped' : 'error';
        if (!e.ok && e.text) reply.text += `${reply.text ? '\n\n' : ''}${e.text}`;
        // the account cannot use this model: say what to do, in words
        if (!e.ok && /model_not_found|model is not supported|not supported when using|does not have access to model|invalid model/i.test(reply.text)) {
          reply.text += `\n\nThis ${h.label} account can't use ${model ? `the model "${model}"` : "the model set in the CLI's own config"}. Pick another model next to the agent menu and send again.`;
        }
        if (e.cost) reply.cost = e.cost;
      }
      this.saveChat();
    });
    run.on('finished', () => {
      this.agentToken = '';
      this.push('agent', { running: false });
    });
    return reply;
  }

  stopAgent() {
    this.run?.stop();
  }

  /** A tool call from the MCP server, made while a turn runs (the token is the turn's). */
  noteTool(name: string, result: ToolResult) {
    const reply = [...this.chat].reverse().find((m) => m.role === 'agent' && m.status === 'running');
    if (!reply) return;
    const summary = result.content.find((c) => c.type === 'text')?.text?.slice(0, 160);
    const last = [...(reply.tools ?? [])].reverse().find((t) => t.name === name && t.ok === undefined);
    if (last) Object.assign(last, { ok: !result.isError, summary });
    else reply.tools!.push({ name, ok: !result.isError, summary });
    this.saveChat();
  }

  // ---- export ----

  startExport(preset: '1080p' | '4k', fps = 30) {
    const s = this.need();
    const host = this.requireHost();
    if (this.exports.some((j) => j.status === 'running')) throw new Error('an export is already running');
    const duration = s.duration();
    if (!(duration > 0)) throw new Error('the film is empty');
    const scale = preset === '4k' ? 3840 / s.film.stage.w : 1920 / s.film.stage.w;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(s.root, EXPORTS_DIR, `${safeName(s.meta.name)}-${preset}-${stamp}.mp4`);
    const job: ExportJob = { id: randomUUID(), preset, status: 'running', frame: 0, frames: Math.round(duration * fps), phase: 'starting', startedAt: new Date().toISOString() };
    this.exports.unshift(job);
    this.exportAbort = new AbortController();
    const t0 = Date.now();
    exportFilm(host, {
      root: s.root,
      origin: this.previewOrigin(),
      stage: s.film.stage,
      duration,
      out,
      scale,
      fps,
      signal: this.exportAbort.signal,
      onProgress: (p) => {
        Object.assign(job, p);
        this.push('export', job);
      },
    })
      .then(async (r) => {
        Object.assign(job, { status: 'done', out: r.out, seconds: (Date.now() - t0) / 1000, probe: await probeExport(r.out) });
        this.push('export', job);
      })
      .catch((e) => {
        Object.assign(job, { status: 'error', error: (e as Error).message });
        this.push('export', job);
      });
    return job;
  }

  cancelExport() {
    this.exportAbort?.abort();
  }
}

async function probeExport(file: string) {
  const { run } = await import('../core/media.js');
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height,avg_frame_rate,pix_fmt', '-of', 'json', file]);
  try {
    return { file: basename(file), ...JSON.parse(r.stdout) };
  } catch {
    return null;
  }
}
