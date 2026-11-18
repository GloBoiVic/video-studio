// Drawing frames of a film: for the agent's eyes (look), annotation images and export. The browser that draws is a
// FrameHost: in the app, an offscreen Electron window (electron/frame-host.ts). It follows the OpenFilm host
// protocol (SPEC §4): clocks held at t, frame(t) awaited, videos waited for, two animation frames, then capture.
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { audioClips, mix } from 'openfilm/shared';
import type { Shape } from '../core/types.js';

export type Captured = { png(): Buffer; bitmap(): Buffer; size: { width: number; height: number } };
export interface FramePage {
  eval<T = unknown>(js: string): Promise<T>;
  capture(): Promise<Captured>;
  close(): Promise<void>;
}
export interface FrameHost {
  /** A page sized w × h CSS px, drawn at `scale` device pixels per CSS px. */
  open(url: string, opts: { w: number; h: number; scale: number; transparent?: boolean }): Promise<FramePage>;
}

const SEEK = (t: number) => `(async () => {
  const t = ${JSON.stringify(t)};
  if (!window.film || typeof window.film.frame !== 'function') throw new Error('window.film.frame is gone');
  window.filmHost?.time?.(t);
  await window.film.frame(t);
  window.filmHost?.settle?.(t);
  await Promise.all([...document.querySelectorAll('video')].map((v) => (v.seeking || v.readyState < 2)
    && v.networkState !== v.NETWORK_EMPTY && v.checkVisibility?.({ visibilityProperty: true }) !== false
    ? new Promise((r) => {
      const shown = () => (typeof v.requestVideoFrameCallback === 'function' ? (v.requestVideoFrameCallback(() => r()), setTimeout(r, 1000)) : r());
      v.addEventListener('seeked', shown, { once: true }); v.addEventListener('loadeddata', shown, { once: true }); setTimeout(r, 3000);
    }) : null));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  return true;
})()`;

const READY = `(async () => {
  for (let i = 0; !window.film; i++) { if (i > 500) throw new Error('film.html did not start (no window.film)'); await new Promise((r) => setTimeout(r, 20)); }
  const r = window.film.ready; await (typeof r === 'function' ? r() : r);
  return { duration: window.film.duration, sounds: window.__filmSounds ? window.__filmSounds() : [] };
})()`;

export type FilmSound = { src: string; at: number; from: number; to?: number; volume: number; speed: number; fade?: [number, number] };

export async function openFilm(host: FrameHost, origin: string, stage: { w: number; h: number }, scale: number) {
  const page = await host.open(`${origin}/film.html?film-host=1`, { w: stage.w, h: stage.h, scale });
  try {
    const facts = await page.eval<{ duration: number; sounds: FilmSound[] }>(READY);
    return { page, facts };
  } catch (e) {
    await page.close();
    throw e;
  }
}

export async function seek(page: FramePage, t: number) {
  await page.eval(SEEK(t));
}

/** PNG frames of the film at the given times. */
export async function look(host: FrameHost, origin: string, stage: { w: number; h: number }, times: number[], width = 960) {
  const scale = Math.min(2, Math.max(0.1, width / stage.w));
  const { page } = await openFilm(host, origin, stage, scale);
  try {
    const out: Buffer[] = [];
    for (const t of times) {
      await seek(page, t);
      out.push((await page.capture()).png());
    }
    return out;
  } finally {
    await page.close();
  }
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The person's drawing over a frame, as SVG in stage pixels. */
export function shapesSvg(shapes: Shape[], stage: { w: number; h: number }, color = '#ff2d55') {
  const sw = Math.max(4, Math.round(stage.w / 300));
  const parts = shapes.map((s) => {
    switch (s.kind) {
      case 'circle':
        return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${Math.abs(s.rx)}" ry="${Math.abs(s.ry)}"/>`;
      case 'rect':
        return `<rect x="${Math.min(s.x, s.x + s.w)}" y="${Math.min(s.y, s.y + s.h)}" width="${Math.abs(s.w)}" height="${Math.abs(s.h)}" rx="${sw}"/>`;
      case 'arrow': {
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const L = sw * 5;
        const p1 = [s.x2 - L * Math.cos(a - 0.45), s.y2 - L * Math.sin(a - 0.45)];
        const p2 = [s.x2 - L * Math.cos(a + 0.45), s.y2 - L * Math.sin(a + 0.45)];
        return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/><polyline points="${p1.join(',')} ${s.x2},${s.y2} ${p2.join(',')}"/>`;
      }
      case 'pen':
        return `<polyline points="${s.points.map((p) => p.join(',')).join(' ')}"/>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${stage.w} ${stage.h}" width="${stage.w}" height="${stage.h}" style="position:absolute;left:0;top:0;width:100%;height:100%" fill="none" stroke="${esc(color)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</svg>`;
}

/** The frame at t with the person's drawing on it, and a label with the time: what the agent sees. */
export async function annotationImage(host: FrameHost, origin: string, stage: { w: number; h: number }, t: number, shapes: Shape[], note: string, width = 1280) {
  const [frame] = await look(host, origin, stage, [t], width);
  const scale = width / stage.w;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${stage.w}px;height:${stage.h}px;position:relative;overflow:hidden;background:#000">
<img src="data:image/png;base64,${frame.toString('base64')}" style="position:absolute;left:0;top:0;width:100%;height:100%">
${shapesSvg(shapes, stage)}
<div style="position:absolute;left:${stage.w * 0.015}px;top:${stage.h * 0.02}px;padding:${stage.h * 0.008}px ${stage.w * 0.008}px;background:rgba(0,0,0,.72);color:#fff;font:600 ${Math.round(stage.h * 0.022)}px -apple-system,Helvetica,sans-serif;border-radius:6px;max-width:70%">${esc(`t=${t.toFixed(2)}s · ${note}`.slice(0, 200))}</div>
</body>`;
  const page = await host.open(`data:text/html;base64,${Buffer.from(html).toString('base64')}`, { w: stage.w, h: stage.h, scale });
  try {
    await page.eval('new Promise((r) => { const i = document.querySelector("img"); (i.complete ? Promise.resolve() : new Promise((d) => (i.onload = d))).then(() => requestAnimationFrame(() => requestAnimationFrame(r))); })');
    return (await page.capture()).png();
  } finally {
    await page.close();
  }
}

export type ExportOptions = {
  root: string;
  origin: string;
  stage: { w: number; h: number };
  duration: number;
  out: string;
  /** 1 = the stage's size (1080p for a 1920 stage), 2 = twice it (4K) */
  scale: number;
  fps: number;
  onProgress?: (p: { frame: number; frames: number; phase: string }) => void;
  signal?: AbortSignal;
};

/** Render the film to an H.264/AAC MP4: frames from the host piped into ffmpeg, sound mixed by OpenFilm's mixer. */
export async function exportFilm(host: FrameHost, o: ExportOptions) {
  const frames = Math.max(1, Math.round(o.duration * o.fps));
  mkdirSync(dirname(o.out), { recursive: true });
  const partial = `${o.out}.partial.mp4`;
  const audio = `${o.out}.audio.m4a`;
  const { page, facts } = await openFilm(host, o.origin, o.stage, o.scale);
  let ff: ReturnType<typeof spawn> | null = null;
  try {
    o.onProgress?.({ frame: 0, frames, phase: 'sound' });
    const clips = audioClips(o.root, 'film.html', facts.sounds as never, 0);
    const hasAudio = clips.length > 0;
    if (hasAudio) await mix(clips, o.duration, audio, ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000']);

    await seek(page, 0);
    const first = await page.capture();
    const { width, height } = first.size;
    const evenW = width - (width % 2);
    const evenH = height - (height % 2);
    const args = [
      '-v', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', String(o.fps), '-i', 'pipe:0',
      ...(hasAudio ? ['-i', audio] : []),
      '-map', '0:v', ...(hasAudio ? ['-map', '1:a', '-c:a', 'copy'] : []),
      ...(evenW !== width || evenH !== height ? ['-vf', `crop=${evenW}:${evenH}:0:0`] : []),
      '-c:v', 'libx264', '-preset', o.scale > 1 ? 'fast' : 'medium', '-crf', o.scale > 1 ? '18' : '16',
      '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', '-t', String(o.duration), partial,
    ];
    ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr!.on('data', (d) => (err += d));
    const exited = new Promise<number>((done) => ff!.on('close', (c) => done(c ?? -1)));
    const write = (buf: Buffer) =>
      new Promise<void>((done, fail) => {
        if (!ff!.stdin!.write(buf, (e) => e && fail(e))) ff!.stdin!.once('drain', () => done());
        else done();
      });
    const expect = width * height * 4;
    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw new Error('export stopped');
      let shot = first;
      if (i > 0) {
        await seek(page, i / o.fps);
        shot = await page.capture();
      }
      const bmp = shot.bitmap();
      if (bmp.length !== expect) throw new Error(`frame ${i} came out ${shot.size.width}x${shot.size.height}, expected ${width}x${height}`);
      await write(bmp);
      if (i % 10 === 0 || i === frames - 1) o.onProgress?.({ frame: i + 1, frames, phase: 'frames' });
    }
    ff.stdin!.end();
    const code = await exited;
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`);
    renameSync(partial, o.out);
    o.onProgress?.({ frame: frames, frames, phase: 'done' });
    return { out: o.out, frames, width: evenW, height: evenH, fps: o.fps, audio: hasAudio };
  } catch (e) {
    ff?.kill('SIGKILL');
    rmSync(partial, { force: true });
    throw e;
  } finally {
    rmSync(audio, { force: true });
    await page.close();
  }
}
