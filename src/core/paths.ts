import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/** Project layout. film.html is the edit; media/ is raw footage (read-only); graphics/ holds pages. */
export const FILM = 'film.html';
export const MEDIA_DIR = 'media';
export const GRAPHICS_DIR = 'graphics';
export const EXPORTS_DIR = 'exports';
export const STUDIO_DIR = '.studio';

/** A name safe as one path segment: letters, digits, dash, underscore, dot; no leading dot. */
export function safeName(name: string, fallback = 'item'): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return base || fallback;
}

/** True when `child` is `root` or inside it, after resolving symlinks where the path exists. */
export function isInside(root: string, child: string): boolean {
  // the real path of the nearest part that exists, with the rest appended (a file not written yet)
  const real = (p: string): string => {
    const abs = resolve(p);
    try {
      return realpathSync.native(abs);
    } catch {
      const parent = dirname(abs);
      return parent === abs ? abs : join(real(parent), basename(abs));
    }
  };
  const back = relative(real(root), real(child));
  return back === '' || (!back.startsWith('..') && !isAbsolute(back));
}

/**
 * Resolve a project-relative path, refusing absolute paths, `..`, hidden segments (the editor's own `.studio`)
 * and symlinks out of the project. Returns the absolute path or throws.
 */
export function projectPath(root: string, rel: string, { allowHidden = false } = {}): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel)) {
    throw new Error(`not a project path: ${JSON.stringify(rel)}`);
  }
  const parts = normalize(rel).split(sep);
  if (parts.some((p) => p === '..')) throw new Error(`path leaves the project: ${rel}`);
  if (!allowHidden && parts.some((p) => p.startsWith('.'))) throw new Error(`hidden path: ${rel}`);
  const abs = join(root, ...parts);
  if (!isInside(root, abs)) throw new Error(`path leaves the project: ${rel}`);
  return abs;
}
