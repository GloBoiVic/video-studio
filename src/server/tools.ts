// The agent's tools. The MCP server (src/mcp/main.ts) lists these and forwards each call here, so every agent edit
// goes through the project store like the person's own.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CommandZ } from '../core/commands.js';
import { projectPath } from '../core/paths.js';
import type { Studio } from './studio.js';
import { look } from './render.js';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

type Tool = { name: string; description: string; schema: z.ZodType; run(args: any, studio: Studio): Promise<ToolResult> };

const text = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const rev = z.number().int().min(0).describe('the revision from get_project; a stale one is refused');
const BoxZ = z.object({ x: z.number(), y: z.number(), w: z.number().positive().optional(), h: z.number().positive().optional(), r: z.number().optional() }).strict();

const tools: Tool[] = [
  {
    name: 'get_project',
    description: 'The project now: revision, stage, duration, tracks and clips (start/end on the film, in/out of the source), media files with durations, graphics, styles, open annotations, project instructions. Call first in every turn.',
    schema: z.object({}).strict(),
    async run(_a, studio) {
      const s = studio.need();
      return text({
        ...s.summary(),
        media: Object.values(s.media).map((m) => ({ src: m.src, kind: m.kind, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio })),
        graphics: Object.values(s.graphics).filter((g) => s.exists(g.src)),
        openAnnotations: s.annotations.filter((a) => a.status === 'open').map((a) => ({ id: a.id, t: a.t, note: a.note })),
        playhead: studio.playhead,
        selection: studio.selection,
        instructions: studio.projectInstructions() || undefined,
      });
    },
  },
  {
    name: 'apply_edits',
    description:
      'Change the timeline. One call = one undo step for the person, applied all or nothing. Commands: add_track{index?}, remove_track{index}, set_track{index,hidden?,muted?}, add_clip{src,track,at,in?,out?,id?,box?,volume?,speed?,style?,class?,fade?}, update_clip{id,track?,at?,in?,out?,box?,volume?,speed?,style?,class?,fade?,disabled?}, remove_clip{id}, split_clip{id,at}, set_stage{w,h}, set_styles{css} (the film\'s whole <style>: @keyframes and classes clips use). Track index = number of tracks adds a new bottom track.',
    schema: z.object({ label: z.string().min(1).max(120).describe('what this edit does, shown in the undo history'), expected_revision: rev, commands: z.array(CommandZ).min(1).max(200) }).strict(),
    async run(a, studio) {
      const r = await studio.need().apply({ label: a.label, author: 'agent', expectedRevision: a.expected_revision, commands: a.commands });
      return text(r);
    },
  },
  {
    name: 'look',
    description: 'See frames of the film as it renders now (PNG). Use after editing to check your work.',
    schema: z.object({ times: z.array(z.number().min(0)).min(1).max(6).describe('film times in seconds'), width: z.number().int().min(320).max(1920).default(960) }).strict(),
    async run(a, studio) {
      const s = studio.need();
      const pngs = await look(studio.requireHost(), studio.previewOrigin(), s.film.stage, a.times, a.width);
      return { content: pngs.flatMap((p, i) => [{ type: 'text' as const, text: `t=${a.times[i]}s` }, { type: 'image' as const, data: p.toString('base64'), mimeType: 'image/png' }]) };
    },
  },
  {
    name: 'list_templates',
    description: 'Reusable graphics in the person\'s library (and the brand colors), with their parameters.',
    schema: z.object({}).strict(),
    async run(_a, studio) {
      return text({ brand: studio.library.brand(), templates: studio.library.list().map(({ id, name, description, duration, params, source }) => ({ id, name, description, duration, params, source })) });
    },
  },
  {
    name: 'add_template_graphic',
    description: 'Copy a library template into the project with its parameters filled in, and place it on the timeline (one undo step).',
    schema: z
      .object({
        template: z.string(),
        params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
        name: z.string().max(60).optional().describe('file name for the copy in graphics/'),
        duration: z.number().positive().max(3600).optional(),
        track: z.number().int().min(0),
        at: z.number().min(0),
        box: BoxZ.optional(),
        expected_revision: rev,
      })
      .strict(),
    async run(a, studio) {
      const r = studio.library.render(a.template, { ...a.params, ...(a.duration ? { duration: a.duration } : {}) });
      const name = a.name ?? `${a.template}-${Date.now().toString(36).slice(-4)}`;
      return studio.placeGraphic({ name, html: r.html, duration: r.duration, place: { track: a.track, at: a.at, box: a.box }, expectedRevision: a.expected_revision, label: `Add ${r.meta.name}`, template: a.template, params: r.params });
    },
  },
  {
    name: 'write_graphic',
    description:
      'Write a new graphic page (or replace one) in graphics/<name>.html, optionally placing it on the timeline in the same undo step. The page must set window.film = { duration, frame(t) } and draw deterministically from t; no network, transparent background. Put tweakable values in <script id="studio-params">window.PARAMS = {...}</script> so it can become a template.',
    schema: z
      .object({
        name: z.string().min(1).max(60),
        html: z.string().min(20).max(500_000),
        duration: z.number().positive().max(3600).nullable(),
        place: z.object({ track: z.number().int().min(0), at: z.number().min(0), box: BoxZ.optional() }).strict().optional(),
        expected_revision: rev,
      })
      .strict(),
    async run(a, studio) {
      return studio.placeGraphic({ name: a.name, html: a.html, duration: a.duration, place: a.place, expectedRevision: a.expected_revision, label: `Graphic ${a.name}` });
    },
  },
  {
    name: 'read_graphic',
    description: 'The HTML of a graphic page in the project (graphics/...), to change it with write_graphic.',
    schema: z.object({ src: z.string() }).strict(),
    async run(a, studio) {
      const s = studio.need();
      if (!a.src.startsWith('graphics/')) throw new Error('only graphics/ pages');
      return text(readFileSync(projectPath(s.root, a.src), 'utf8'));
    },
  },
  {
    name: 'save_template',
    description: 'Save a project graphic to the person\'s library as a reusable template (available in every project). Describe its window.PARAMS keys as params.',
    schema: z
      .object({
        src: z.string(),
        id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
        name: z.string().min(1).max(80),
        description: z.string().max(500).default(''),
        params: z.record(z.string(), z.object({ type: z.enum(['text', 'color', 'number']), label: z.string().optional(), default: z.union([z.string(), z.number()]).optional() })).default({}),
      })
      .strict(),
    async run(a, studio) {
      const s = studio.need();
      if (!a.src.startsWith('graphics/')) throw new Error('only graphics/ pages');
      const html = readFileSync(projectPath(s.root, a.src), 'utf8');
      const saved = studio.library.save({ id: a.id, name: a.name, description: a.description, duration: s.graphics[a.src]?.duration ?? null, params: a.params, html });
      studio.push('library', studio.library.list());
      return text({ saved });
    },
  },
  {
    name: 'get_annotations',
    description: 'The person\'s notes drawn on frames: time, the clips on screen, shapes in stage pixels, their words, and an image of the frame with the drawing.',
    schema: z.object({ status: z.enum(['open', 'all']).default('open'), ids: z.array(z.string()).optional() }).strict(),
    async run(a, studio) {
      const s = studio.need();
      const list = s.annotations.filter((x) => (a.ids ? a.ids.includes(x.id) : a.status === 'all' || x.status === 'open'));
      const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(list.map(({ image: _i, ...x }) => x), null, 1) }];
      for (const x of list.slice(0, 6)) {
        if (!x.image) continue;
        try {
          content.push({ type: 'text', text: `${x.id} at t=${x.t}s` }, { type: 'image', data: readFileSync(projectPath(s.root, x.image, { allowHidden: true })).toString('base64'), mimeType: 'image/png' });
        } catch {
          /* image missing */
        }
      }
      return { content };
    },
  },
  {
    name: 'resolve_annotation',
    description: 'Mark an annotation as dealt with, with one line saying what you changed.',
    schema: z.object({ id: z.string(), resolution: z.string().min(1).max(300) }).strict(),
    async run(a, studio) {
      const r = studio.need().updateAnnotation(a.id, { status: 'resolved', resolution: a.resolution });
      return text(r);
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change to the film (yours or the person\'s). Prefer a new edit when you can.',
    schema: z.object({}).strict(),
    async run(_a, studio) {
      return text(await studio.need().undo('agent'));
    },
  },
  {
    name: 'import_media',
    description: 'Copy a media file into the project (read-only). Only from folders the person allowed in project settings (access.json readRoots).',
    schema: z.object({ path: z.string() }).strict(),
    async run(a, studio) {
      const s = studio.need();
      const abs = resolve(a.path);
      if (!s.agentMayRead(abs)) throw new Error(`not allowed: ${abs} is outside the folders the person allowed (${s.access.readRoots.join(', ') || 'none'})`);
      return text(await s.importMedia(abs, { from: 'agent' }));
    },
  },
];

export const TOOLS = tools;

export function toolList() {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) }));
}

export async function callTool(name: string, args: unknown, studio: Studio): Promise<ToolResult> {
  const t = tools.find((x) => x.name === name);
  if (!t) return { content: [{ type: 'text', text: `no tool ${name}` }], isError: true };
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) return { content: [{ type: 'text', text: `bad arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }], isError: true };
  try {
    return await t.run(parsed.data, studio);
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
}
