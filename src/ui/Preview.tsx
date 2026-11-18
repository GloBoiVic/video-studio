// The preview: film.html played by OpenFilm's timeline in an iframe on the project's own origin (isolated from the
// app), driven by postMessage. Over it, a drawing layer for annotations in stage pixels.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Project, Shape } from './api';

type Facts = { duration: number; sounds: Array<{ src: string; at: number; from: number; to?: number; volume: number; speed: number }> };
export type PreviewHandle = { seek(t: number): void; toggle(): void; playing: boolean };
type Tool = 'none' | 'circle' | 'arrow' | 'rect' | 'pen';

let rpcId = 0;

export const Preview = forwardRef<PreviewHandle, {
  project: Project;
  t: number;
  setT(t: number): void;
  onAnnotate(shapes: Shape[]): void;
  drawing: Shape[];
  setDrawing(s: Shape[]): void;
  reloadKey: number;
}>(function Preview({ project, t, setT, onAnnotate, drawing, setDrawing, reloadKey }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pending = useRef(new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [scale, setScale] = useState(0.4);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<Tool>('none');
  const facts = useRef<Facts | null>(null);
  const busy = useRef(false);
  const wantT = useRef(t);
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const { stage, previewOrigin } = project;

  const rpc = useCallback(<T,>(op: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((done, fail) => {
      const id = ++rpcId;
      pending.current.set(id, (r) => (r.ok ? done(r.result as T) : fail(new Error(r.error))));
      frame.current?.contentWindow?.postMessage({ id, op, args }, previewOrigin);
      setTimeout(() => pending.current.has(id) && (pending.current.delete(id), fail(new Error(`${op} timed out`))), 30_000);
    }), [previewOrigin]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== previewOrigin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'film-error') return setError(String(e.data.message));
      const cb = pending.current.get(e.data?.id);
      if (cb) {
        pending.current.delete(e.data.id);
        cb(e.data);
      }
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, [previewOrigin]);

  // fit the stage into the available box
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setScale(Math.min(el.clientWidth / stage.w, el.clientHeight / stage.h)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [stage.w, stage.h]);

  const draw = useCallback(async (time: number, play: boolean) => {
    wantT.current = time;
    if (busy.current || !ready) return;
    busy.current = true;
    try {
      while (true) {
        const at = wantT.current;
        await rpc('watch', { t: at, play: play ? { rate: 1, now: at } : null });
        if (wantT.current === at) break;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [ready, rpc]);

  const onLoad = useCallback(async () => {
    setReady(false);
    setError('');
    try {
      facts.current = await rpc<Facts>('ready');
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [rpc]);

  // film changed: update in place; graphics changed (reloadKey): load again
  const lastRev = useRef(project.revision);
  useEffect(() => {
    if (!ready || project.revision === lastRev.current) return;
    lastRev.current = project.revision;
    (async () => {
      const ok = await rpc<boolean>('update', { value: project.film }).catch(() => false);
      if (ok === false) frame.current?.contentWindow?.location.replace(`${previewOrigin}/film.html?film-missing=skip&r=${project.revision}`);
      else {
        facts.current = await rpc<Facts>('facts');
        void draw(wantT.current, false);
      }
    })();
  }, [project.revision, project.film, ready, rpc, draw, previewOrigin]);

  useEffect(() => {
    if (ready && !playing) void draw(t, false);
  }, [t, ready, playing, draw]);

  // playback: the clock is here; the film is drawn at each animation frame; sound from <audio> elements in step
  useEffect(() => {
    if (!playing) {
      audios.current.forEach((a) => a.pause());
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = wantT.current >= project.duration - 0.05 ? 0 : wantT.current;
    const tick = () => {
      const now = from + (performance.now() - start) / 1000;
      if (now >= project.duration) {
        setPlaying(false);
        setT(project.duration);
        return;
      }
      setT(now);
      void draw(now, true);
      for (const s of facts.current?.sounds ?? []) {
        const key = `${s.src}@${s.at}`;
        let a = audios.current.get(key);
        if (!a) {
          a = new Audio(new URL(s.src, `${previewOrigin}/film.html`).href);
          a.preload = 'auto';
          audios.current.set(key, a);
        }
        const len = ((s.to ?? Infinity) - s.from) / s.speed;
        const on = now >= s.at && now < s.at + len;
        const want = s.from + (now - s.at) * s.speed;
        if (on) {
          a.volume = Math.min(1, s.volume);
          a.playbackRate = s.speed;
          if (a.paused || Math.abs(a.currentTime - want) > 0.2) {
            a.currentTime = want;
            void a.play().catch(() => undefined);
          }
        } else if (!a.paused) a.pause();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project.duration, draw, setT, previewOrigin]);

  useImperativeHandle(ref, () => ({ seek: (x) => setT(Math.max(0, x)), toggle: () => setPlaying((p) => !p), playing }), [setT, playing]);

  // ---- drawing ----
  const start = useRef<[number, number] | null>(null);
  const toStage = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * stage.w, ((e.clientY - r.top) / r.height) * stage.h] as [number, number];
  };
  const [live, setLive] = useState<Shape | null>(null);
  const shapeFrom = (a: [number, number], b: [number, number]): Shape | null => {
    if (tool === 'circle') return { kind: 'circle', cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 };
    if (tool === 'rect') return { kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    if (tool === 'arrow') return { kind: 'arrow', x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
    return null;
  };
  const down = (e: React.PointerEvent) => {
    if (tool === 'none') return;
    setPlaying(false);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toStage(e);
    start.current = p;
    setLive(tool === 'pen' ? { kind: 'pen', points: [p] } : shapeFrom(p, p));
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = toStage(e);
    setLive((l) => (tool === 'pen' && l?.kind === 'pen' ? { kind: 'pen', points: [...l.points, p] } : shapeFrom(start.current!, p)));
  };
  const up = () => {
    if (live) {
      const big = live.kind === 'pen' ? live.points.length > 3 : live.kind === 'arrow' ? Math.hypot(live.x2 - live.x1, live.y2 - live.y1) > 20 : live.kind === 'circle' ? live.rx + live.ry > 15 : live.w + live.h > 20;
      if (big) setDrawing([...drawing, live]);
    }
    start.current = null;
    setLive(null);
  };

  const sw = Math.max(4, stage.w / 300);
  const render = (s: Shape, i: number | string) => {
    const p = { key: i, fill: 'none', stroke: '#ff2d55', strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
    if (s.kind === 'circle') return <ellipse {...p} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />;
    if (s.kind === 'rect') return <rect {...p} x={s.x} y={s.y} width={s.w} height={s.h} rx={sw} />;
    if (s.kind === 'pen') return <polyline {...p} points={s.points.map((q) => q.join(',')).join(' ')} />;
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const L = sw * 5;
    return (
      <g key={i}>
        <line {...p} key={undefined} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
        <polyline {...p} key={undefined} points={`${s.x2 - L * Math.cos(a - 0.45)},${s.y2 - L * Math.sin(a - 0.45)} ${s.x2},${s.y2} ${s.x2 - L * Math.cos(a + 0.45)},${s.y2 - L * Math.sin(a + 0.45)}`} />
      </g>
    );
  };

  return (
    <div className="preview">
      <div className="stage-box" ref={box}>
        <div className="stage" style={{ width: stage.w * scale, height: stage.h * scale }}>
          <iframe
            key={`${previewOrigin}-${reloadKey}`}
            ref={frame}
            title="preview"
            src={`${previewOrigin}/film.html?film-missing=skip`}
            onLoad={onLoad}
            sandbox="allow-scripts allow-same-origin"
            style={{ width: stage.w, height: stage.h, transform: `scale(${scale})` }}
          />
          <svg className={`ink ${tool !== 'none' ? 'on' : ''}`} viewBox={`0 0 ${stage.w} ${stage.h}`} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
            {drawing.map(render)}
            {live && render(live, 'live')}
          </svg>
          {!ready && !error && <div className="stage-note">Loading…</div>}
          {error && <div className="stage-note err">{error}</div>}
        </div>
      </div>
      <div className="transport">
        <button className="play" onClick={() => setPlaying((p) => !p)} title="Play / pause (Space)">{playing ? '❚❚' : '▶'}</button>
        <span className="time">{t.toFixed(2)} / {project.duration.toFixed(2)} s</span>
        <div className="spacer" />
        <div className="tools" role="toolbar" aria-label="Annotate">
          <span className="label">Mark up</span>
          {(['circle', 'arrow', 'rect', 'pen'] as Tool[]).map((k) => (
            <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(tool === k ? 'none' : k)} title={k}>
              {k === 'circle' ? '◯' : k === 'arrow' ? '↗' : k === 'rect' ? '▢' : '✎'}
            </button>
          ))}
          {drawing.length > 0 && (
            <>
              <button onClick={() => setDrawing(drawing.slice(0, -1))} title="Remove last mark">⌫</button>
              <button className="primary" onClick={() => { setTool('none'); onAnnotate(drawing); }}>Add note…</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
