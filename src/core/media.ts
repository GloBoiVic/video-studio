import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
export const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
export const SOUND_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus']);

export function kindOfExt(ext: string): 'video' | 'still' | 'sound' | null {
  const e = ext.toLowerCase();
  if (VIDEO_EXT.has(e)) return 'video';
  if (STILL_EXT.has(e)) return 'still';
  if (SOUND_EXT.has(e)) return 'sound';
  return null;
}

export function run(cmd: string, args: string[], { timeoutMs = 120_000 } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type Probe = { duration: number | null; width?: number; height?: number; hasAudio: boolean; hasVideo: boolean; fps?: number };

/** ffprobe a file. Untrusted media is only ever read by ffprobe/ffmpeg and the browser, never executed. */
export async function probe(file: string): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,duration', '-of', 'json', file], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`ffprobe could not read ${file}: ${r.stderr.trim().split('\n')[0]}`);
  const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type: string; width?: number; height?: number; avg_frame_rate?: string }> };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const d = Number(j.format?.duration);
  let fps: number | undefined;
  if (v?.avg_frame_rate && v.avg_frame_rate.includes('/')) {
    const [n, m] = v.avg_frame_rate.split('/').map(Number);
    if (m) fps = n / m;
  }
  return { duration: Number.isFinite(d) && d > 0 ? d : null, width: v?.width, height: v?.height, hasAudio: !!a, hasVideo: !!v, fps };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', fail)
      .on('end', () => done(h.digest('hex')));
  });
}
