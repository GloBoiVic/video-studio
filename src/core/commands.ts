// Edit commands: the one way anything (the timeline UI, the agent, tests) changes a film. A batch is applied to a
// copy, validated as a whole, and kept all or nothing (see store.ts).
import { clipIdFor } from 'openfilm/film-doc';
import { z } from 'zod';
import type { Author, Clip, Film } from './types.js';

const num = z.number().finite();
const time = num.min(0).max(86_400);
const clipId = z.string().regex(/^[A-Za-z][\w-]{0,63}$/, 'ids are letters, digits, - and _, starting with a letter');
const BoxZ = z.object({ x: num, y: num, w: num.positive().optional(), h: num.positive().optional(), r: num.optional() }).strict();
const FadeZ = z.tuple([num.min(0).max(60), num.min(0).max(60)]);
const SrcZ = z.string().min(1).max(300);

export const CommandZ = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_track'), index: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal('remove_track'), index: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal('set_track'), index: z.number().int().min(0), hidden: z.boolean().optional(), muted: z.boolean().optional(), locked: z.boolean().optional() }).strict(),
  z
    .object({
      op: z.literal('add_clip'),
      src: SrcZ,
      track: z.number().int().min(0),
      at: time,
      in: time.optional(),
      out: time.optional(),
      id: clipId.optional(),
      box: BoxZ.optional(),
      volume: num.min(0).max(4).optional(),
      speed: num.min(0.1).max(100).optional(),
      style: z.string().max(4000).optional(),
      class: z.string().max(200).optional(),
      fade: FadeZ.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('update_clip'),
      id: clipId,
      track: z.number().int().min(0).optional(),
      at: time.optional(),
      in: time.optional(),
      out: time.optional(),
      box: BoxZ.nullable().optional(),
      volume: num.min(0).max(4).optional(),
      speed: num.min(0.1).max(100).optional(),
      style: z.string().max(4000).nullable().optional(),
      class: z.string().max(200).nullable().optional(),
      fade: FadeZ.nullable().optional(),
      disabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove_clip'), id: clipId }).strict(),
  z.object({ op: z.literal('split_clip'), id: clipId, at: time }).strict(),
  z.object({ op: z.literal('set_stage'), w: z.number().int().min(16).max(8192), h: z.number().int().min(16).max(8192) }).strict(),
  z.object({ op: z.literal('set_styles'), css: z.string().max(50_000) }).strict(),
]);

export type Command = z.infer<typeof CommandZ>;

export type ApplyContext = {
  author: Author;
  /** native length of a source in seconds (media duration or a page's own duration); null when it has no end */
  lengthOf(src: string): number | null;
  /** whether a source exists in the project and may be used */
  exists(src: string): boolean;
  /** whether the source is a still picture (needs an explicit length) */
  isStill(src: string): boolean;
};

export type ApplyResult = { film: Film; css: string | null; results: Array<Record<string, unknown>> };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function clipLength(clip: Clip, ctx: Pick<ApplyContext, 'lengthOf'>): number | null {
  const speed = clip.speed ?? 1;
  const [from = 0, to] = clip.time ?? [];
  const end = to ?? ctx.lengthOf(clip.src);
  if (end == null) return null;
  return r3((end - from) / speed);
}

function fadeOf(c: Clip): [number, number] | null {
  const own = c.overrides?.find((o) => !('at' in o)) as { fade?: [number, number] } | undefined;
  return own?.fade ?? null;
}
function setFade(c: Clip, fade: [number, number] | null) {
  const rest = (c.overrides ?? []).filter((o) => 'at' in o);
  const next = fade && (fade[0] > 0 || fade[1] > 0) ? [...rest, { fade: [r3(fade[0]), r3(fade[1])] }] : rest;
  if (next.length) c.overrides = next;
  else delete c.overrides;
}

function find(film: Film, id: string): { ti: number; ci: number; clip: Clip } {
  for (let ti = 0; ti < film.tracks.length; ti++) {
    const ci = film.tracks[ti].clips.findIndex((c) => c.id === id);
    if (ci >= 0) return { ti, ci, clip: film.tracks[ti].clips[ci] };
  }
  throw new Error(`no clip with id "${id}"`);
}

function guardTrack(film: Film, ti: number, ctx: ApplyContext) {
  const tr = film.tracks[ti];
  if (!tr) throw new Error(`no track ${ti} (the film has ${film.tracks.length})`);
  if (tr.locked && ctx.author === 'agent') throw new Error(`track ${ti} is locked by the person: the agent may not change it`);
}

function allIds(film: Film): Set<string> {
  return new Set(film.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

function setTiming(clip: Clip, at: number | undefined, from: number | undefined, to: number | undefined) {
  if (at !== undefined) {
    if (at > 0) clip.at = r3(at);
    else delete clip.at;
  }
  if (from !== undefined || to !== undefined) {
    const [f0 = 0, t0] = clip.time ?? [];
    const f = r3(from ?? f0);
    const t = to ?? t0;
    clip.time = t === undefined ? [f] : [f, r3(t)];
    if (t !== undefined && t <= f) throw new Error(`clip "${clip.id}": out (${t}) must be after in (${f})`);
  }
}

/** Apply a batch to a copy of the film. Throws on the first invalid command or if the result is invalid. */
export function applyCommands(input: Film, css: string | null, commands: Command[], ctx: ApplyContext): ApplyResult {
  const film: Film = structuredClone(input);
  let styles = css;
  const results: Array<Record<string, unknown>> = [];

  commands.forEach((raw, i) => {
    const parsed = CommandZ.safeParse(raw);
    if (!parsed.success) throw new Error(`command ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.') || 'command'}: ${x.message}`).join('; ')}`);
    const cmd = parsed.data;
    try {
      switch (cmd.op) {
        case 'add_track': {
          const index = Math.min(cmd.index ?? film.tracks.length, film.tracks.length);
          film.tracks.splice(index, 0, { clips: [] });
          results.push({ op: cmd.op, index });
          break;
        }
        case 'remove_track': {
          guardTrack(film, cmd.index, ctx);
          if (film.tracks[cmd.index].clips.length) throw new Error(`track ${cmd.index} is not empty`);
          film.tracks.splice(cmd.index, 1);
          results.push({ op: cmd.op, index: cmd.index });
          break;
        }
        case 'set_track': {
          const tr = film.tracks[cmd.index];
          if (!tr) throw new Error(`no track ${cmd.index}`);
          if (ctx.author === 'agent' && (tr.locked || cmd.locked !== undefined)) throw new Error('only the person locks and unlocks tracks');
          for (const k of ['hidden', 'muted', 'locked'] as const) {
            if (cmd[k] === undefined) continue;
            if (cmd[k]) tr[k] = true;
            else delete tr[k];
          }
          results.push({ op: cmd.op, index: cmd.index });
          break;
        }
        case 'add_clip': {
          if (!ctx.exists(cmd.src)) throw new Error(`no such file in the project: ${cmd.src} (import media first, or create the graphic)`);
          if (cmd.track > film.tracks.length) throw new Error(`no track ${cmd.track}; use ${film.tracks.length} to add a new bottom track`);
          if (cmd.track === film.tracks.length) film.tracks.push({ clips: [] });
          guardTrack(film, cmd.track, ctx);
          const used = allIds(film);
          if (cmd.id && used.has(cmd.id)) throw new Error(`id "${cmd.id}" is taken`);
          const id = cmd.id ?? clipIdFor(cmd.src, used);
          const clip: Clip = { id, src: cmd.src };
          const native = ctx.lengthOf(cmd.src);
          const from = cmd.in ?? 0;
          let to = cmd.out ?? native ?? undefined;
          if (to === undefined) {
            if (ctx.isStill(cmd.src)) to = from + 5;
            else throw new Error(`${cmd.src} has no length of its own: give "out"`);
          }
          if (native != null && to > native + 0.001) throw new Error(`out (${to}) is past the end of ${cmd.src} (${r3(native)} s)`);
          setTiming(clip, cmd.at, from, to);
          if (cmd.box) clip.box = cmd.box;
          if (cmd.volume !== undefined) clip.volume = cmd.volume;
          if (cmd.speed !== undefined && cmd.speed !== 1) clip.speed = cmd.speed;
          if (cmd.style) clip.style = cmd.style;
          if (cmd.class) clip.class = cmd.class;
          if (cmd.fade) setFade(clip, cmd.fade);
          film.tracks[cmd.track].clips.push(clip);
          results.push({ op: cmd.op, id, track: cmd.track, at: clip.at ?? 0, length: clipLength(clip, ctx) });
          break;
        }
        case 'update_clip': {
          const { ti, ci, clip } = find(film, cmd.id);
          guardTrack(film, ti, ctx);
          const native = ctx.lengthOf(clip.src);
          if (cmd.out !== undefined && native != null && cmd.out > native + 0.001) throw new Error(`out (${cmd.out}) is past the end of ${clip.src} (${r3(native)} s)`);
          setTiming(clip, cmd.at, cmd.in, cmd.out);
          if (cmd.box === null) delete clip.box;
          else if (cmd.box) clip.box = cmd.box;
          if (cmd.volume !== undefined) clip.volume = cmd.volume;
          if (cmd.speed !== undefined) {
            if (cmd.speed === 1) delete clip.speed;
            else clip.speed = cmd.speed;
          }
          for (const k of ['style', 'class'] as const) {
            if (cmd[k] === null || cmd[k] === '') delete clip[k];
            else if (cmd[k] !== undefined) clip[k] = cmd[k] as string;
          }
          if (cmd.fade !== undefined) setFade(clip, cmd.fade);
          if (cmd.disabled !== undefined) {
            if (cmd.disabled) clip.disabled = true;
            else delete clip.disabled;
          }
          if (cmd.track !== undefined && cmd.track !== ti) {
            if (cmd.track > film.tracks.length) throw new Error(`no track ${cmd.track}`);
            if (cmd.track === film.tracks.length) film.tracks.push({ clips: [] });
            guardTrack(film, cmd.track, ctx);
            film.tracks[ti].clips.splice(ci, 1);
            film.tracks[cmd.track].clips.push(clip);
          }
          results.push({ op: cmd.op, id: clip.id });
          break;
        }
        case 'remove_clip': {
          const { ti, ci } = find(film, cmd.id);
          guardTrack(film, ti, ctx);
          film.tracks[ti].clips.splice(ci, 1);
          results.push({ op: cmd.op, id: cmd.id });
          break;
        }
        case 'split_clip': {
          const { ti, ci, clip } = find(film, cmd.id);
          guardTrack(film, ti, ctx);
          const at = clip.at ?? 0;
          const len = clipLength(clip, ctx);
          if (len == null) throw new Error(`clip "${clip.id}" has no end to split before`);
          if (cmd.at <= at + 0.01 || cmd.at >= at + len - 0.01) throw new Error(`split time ${cmd.at} is not inside clip "${clip.id}" (${at}–${r3(at + len)})`);
          const speed = clip.speed ?? 1;
          const [from = 0, to0] = clip.time ?? [];
          const to = to0 ?? ctx.lengthOf(clip.src)!;
          const cut = r3(from + (cmd.at - at) * speed);
          const second: Clip = structuredClone(clip);
          second.id = clipIdFor(clip.src, allIds(film));
          const fade = fadeOf(clip);
          clip.time = [from, cut];
          second.at = r3(cmd.at);
          second.time = [cut, to];
          setFade(clip, fade ? [fade[0], 0] : null);
          setFade(second, fade ? [0, fade[1]] : null);
          film.tracks[ti].clips.splice(ci + 1, 0, second);
          results.push({ op: cmd.op, id: clip.id, newId: second.id });
          break;
        }
        case 'set_stage': {
          film.stage = { w: cmd.w, h: cmd.h };
          results.push({ op: cmd.op });
          break;
        }
        case 'set_styles': {
          if (/<\/?(style|script)\b/i.test(cmd.css)) throw new Error('styles may not contain <style> or <script> tags');
          styles = cmd.css;
          results.push({ op: cmd.op });
          break;
        }
      }
    } catch (e) {
      throw new Error(`command ${i + 1} (${cmd.op}): ${(e as Error).message}`);
    }
  });

  for (const tr of film.tracks) tr.clips.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  validateFilm(film, ctx);
  return { film, css: styles, results };
}

/** Overlaps on a track and clips past their source's end. (film-doc checks the syntax; this checks the timing.) */
export function validateFilm(film: Film, ctx: Pick<ApplyContext, 'lengthOf'>) {
  film.tracks.forEach((tr, ti) => {
    let prev: { id: string; end: number } | null = null;
    for (const c of tr.clips) {
      const at = c.at ?? 0;
      const len = clipLength(c, ctx);
      if (len != null && len <= 0) throw new Error(`clip "${c.id}" has no length`);
      if (prev && at < prev.end - 0.001) throw new Error(`clips "${prev.id}" and "${c.id}" overlap on track ${ti} (${prev.end} > ${at}); put one on another track`);
      prev = { id: c.id, end: len == null ? Infinity : at + len };
    }
  });
}

/** Film length in seconds: the end of its last clip with an end. */
export function filmLength(film: Film, ctx: Pick<ApplyContext, 'lengthOf'>): number {
  let end = 0;
  for (const tr of film.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      const len = clipLength(c, ctx);
      if (len != null) end = Math.max(end, (c.at ?? 0) + len);
    }
  }
  return r3(end);
}
