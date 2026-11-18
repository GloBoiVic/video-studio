// The library: reusable graphics (templates) and brand styles that persist across projects. A template is a folder
// with template.json and page.html, an OpenFilm page that reads its parameters from window.PARAMS. Using one copies
// it into the project (graphics/), so a project never depends on the library to play or export.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { safeName } from './paths.js';

const ParamZ = z.object({
  type: z.enum(['text', 'color', 'number']),
  label: z.string().max(80).optional(),
  default: z.union([z.string().max(500), z.number()]).optional(),
});
export const TemplateMetaZ = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  kind: z.literal('graphic').default('graphic'),
  duration: z.number().positive().max(3600).nullable(),
  params: z.record(z.string().regex(/^[A-Za-z][\w]{0,40}$/), ParamZ).default({}),
  version: z.number().int().min(1).default(1),
});
export type TemplateMeta = z.infer<typeof TemplateMetaZ> & { source: 'built-in' | 'user' };
export type Brand = Record<string, string>;

export const PARAMS_SLOT = '/*@params*/';
const PARAMS_SCRIPT = /<script id="studio-params">[\s\S]*?<\/script>/;

export class Library {
  constructor(readonly builtInDir: string, readonly userDir: string) {}

  private dirs(): Array<{ dir: string; source: 'built-in' | 'user' }> {
    return [
      { dir: join(this.builtInDir, 'templates'), source: 'built-in' },
      { dir: join(this.userDir, 'templates'), source: 'user' },
    ];
  }

  list(): TemplateMeta[] {
    const out = new Map<string, TemplateMeta>();
    for (const { dir, source } of this.dirs()) {
      if (!existsSync(dir)) continue;
      for (const id of readdirSync(dir)) {
        try {
          const meta = TemplateMetaZ.parse(JSON.parse(readFileSync(join(dir, id, 'template.json'), 'utf8')));
          if (source === 'user' && out.get(meta.id)?.source === 'built-in') continue;
          out.set(meta.id, { ...meta, source });
        } catch {
          /* not a template folder */
        }
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): { meta: TemplateMeta; html: string } {
    for (const { dir, source } of this.dirs().reverse()) {
      const f = join(dir, id, 'template.json');
      if (!existsSync(f)) continue;
      const meta = { ...TemplateMetaZ.parse(JSON.parse(readFileSync(f, 'utf8'))), source };
      return { meta, html: readFileSync(join(dir, id, 'page.html'), 'utf8') };
    }
    throw new Error(`no template "${id}" in the library`);
  }

  /** Brand styles: the built-in defaults, overridden by the person's own brand.json. */
  brand(): Brand {
    const read = (d: string) => {
      try {
        return JSON.parse(readFileSync(join(d, 'brand.json'), 'utf8')) as Brand;
      } catch {
        return {};
      }
    };
    return { ...read(this.builtInDir), ...read(this.userDir) };
  }

  setBrand(brand: Brand) {
    const clean = Object.fromEntries(Object.entries(brand).filter(([k, v]) => /^[A-Za-z][\w]{0,40}$/.test(k) && typeof v === 'string' && v.length < 200));
    mkdirSync(this.userDir, { recursive: true });
    writeFileSync(join(this.userDir, 'brand.json'), JSON.stringify(clean, null, 2));
    return this.brand();
  }

  /** The template's page with its parameters filled in: given values, else defaults (`$brand.key` reads the brand). */
  render(id: string, given: Record<string, unknown> = {}) {
    const { meta, html } = this.get(id);
    const brand = this.brand();
    const params: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(meta.params)) {
      let v: unknown = given[k] ?? p.default;
      if (typeof v === 'string' && v.startsWith('$brand.')) v = brand[v.slice(7)] ?? undefined;
      if (v === undefined) continue;
      if (p.type === 'number') v = Number(v);
      else v = String(v);
      if (p.type === 'number' && !Number.isFinite(v as number)) throw new Error(`parameter ${k} must be a number`);
      params[k] = v;
    }
    for (const k of Object.keys(given)) if (!(k in meta.params) && k !== 'duration') throw new Error(`template "${id}" has no parameter "${k}" (it has: ${Object.keys(meta.params).join(', ') || 'none'})`);
    const duration = given.duration !== undefined ? Number(given.duration) : meta.duration;
    if (duration !== null && !(duration > 0)) throw new Error('duration must be a positive number of seconds');
    if (duration !== null) params.duration = duration;
    const json = JSON.stringify(params).replace(/</g, '\\u003c');
    if (!html.includes(PARAMS_SLOT)) throw new Error(`template "${id}" has no ${PARAMS_SLOT} slot`);
    return { html: html.replace(PARAMS_SLOT, `window.PARAMS = ${json};`), duration, params, meta };
  }

  /** Save a page as a user template, so later projects can use it. Its own window.PARAMS become its defaults. */
  save(input: { id: string; name: string; description?: string; duration: number | null; params?: Record<string, z.infer<typeof ParamZ>>; html: string }) {
    const meta = TemplateMetaZ.parse({ id: safeName(input.id).toLowerCase(), name: input.name, description: input.description ?? '', duration: input.duration, params: input.params ?? {} });
    if (this.list().some((t) => t.id === meta.id && t.source === 'built-in')) throw new Error(`"${meta.id}" is a built-in template: choose another id`);
    let html = input.html;
    if (PARAMS_SCRIPT.test(html)) html = html.replace(PARAMS_SCRIPT, `<script id="studio-params">${PARAMS_SLOT}</script>`);
    else html = html.replace(/<head\b[^>]*>/i, (h) => `${h}\n<script id="studio-params">${PARAMS_SLOT}</script>`);
    if (!html.includes(PARAMS_SLOT)) throw new Error('the page needs a <head> to hold its parameters');
    const dir = join(this.userDir, 'templates', meta.id);
    let version = 1;
    try {
      version = TemplateMetaZ.parse(JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'))).version + 1;
    } catch {
      /* new */
    }
    mkdirSync(dir, { recursive: true });
    const write = (f: string, s: string) => {
      writeFileSync(join(dir, `${f}.tmp`), s);
      renameSync(join(dir, `${f}.tmp`), join(dir, f));
    };
    write('page.html', html);
    write('template.json', JSON.stringify({ ...meta, version }, null, 2));
    return { ...meta, version, source: 'user' as const };
  }
}
