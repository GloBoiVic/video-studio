// The timeline: tracks of clips (track 0 on top, as the film stacks them), a ruler, the playhead, annotation pins.
// Dragging a clip moves it (also across tracks); its edges trim it. Every change is one edit sent to the store.
import { useEffect, useRef, useState } from 'react';
import type { Annotation, ClipView, Project } from './api';

type Drag = { id: string; mode: 'move' | 'in' | 'out'; x0: number; y0: number; clip: ClipView; track: number; dt: number; dTrack: number };

const KIND_COLOR: Record<string, string> = { video: 'clip-video', still: 'clip-still', sound: 'clip-sound', graphic: 'clip-graphic' };

export function Timeline({ project, t, setT, selected, setSelected, edit, annotations, changed, onPin }: {
  project: Project;
  t: number;
  setT(t: number): void;
  selected: string[];
  setSelected(ids: string[]): void;
  edit(label: string, commands: unknown[]): Promise<void>;
  annotations: Annotation[];
  changed: Set<string>;
  onPin(a: Annotation): void;
}) {
  const [pps, setPps] = useState(80); // pixels per second
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const total = Math.max(project.duration + 5, 20);
  const ROW = 56;
  const snap = (x: number) => Math.round(x * 30) / 30;

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => d && { ...d, dt: (e.clientX - d.x0) / pps, dTrack: Math.round((e.clientY - d.y0) / ROW) });
    const up = async () => {
      const d = drag;
      setDrag(null);
      if (!d) return;
      const c = d.clip;
      if (Math.abs(d.dt) < 1 / 60 && d.dTrack === 0) return;
      if (d.mode === 'move') {
        const track = Math.max(0, Math.min(project.tracks.length, d.track + d.dTrack));
        await edit(`Move ${c.id}`, [{ op: 'update_clip', id: c.id, at: Math.max(0, snap(c.start + d.dt)), ...(track !== d.track ? { track } : {}) }]);
      } else if (d.mode === 'in') {
        const shift = Math.max(-c.in / (c.speed ?? 1), Math.min(d.dt, (c.end ?? c.start + 1) - c.start - 0.1));
        const sh = Math.max(-c.start, shift);
        await edit(`Trim start of ${c.id}`, [{ op: 'update_clip', id: c.id, at: snap(c.start + sh), in: Math.max(0, snap(c.in + sh * (c.speed ?? 1))) }]);
      } else {
        const len = (c.end ?? c.start) - c.start;
        const newLen = Math.max(0.1, len + d.dt);
        await edit(`Trim end of ${c.id}`, [{ op: 'update_clip', id: c.id, out: snap(c.in + newLen * (c.speed ?? 1)) }]);
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
  }, [drag, pps, edit, project.tracks.length]);

  const seekFromEvent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setT(Math.max(0, Math.min(project.duration, (e.clientX - r.left) / pps)));
  };

  const ticks: number[] = [];
  const step = pps > 120 ? 0.5 : pps > 40 ? 1 : pps > 15 ? 5 : 10;
  for (let s = 0; s <= total; s += step) ticks.push(s);

  return (
    <div className="timeline">
      <div className="tl-bar">
        <span className="tl-title">Timeline</span>
        <button onClick={() => selected[0] && edit('Split', [{ op: 'split_clip', id: selected[0], at: t }])} disabled={!selected.length} title="Split at playhead (S)">Split</button>
        <button onClick={() => selected.length && edit('Delete', selected.map((id) => ({ op: 'remove_clip', id })))} disabled={!selected.length} title="Delete (⌫)">Delete</button>
        <button onClick={() => edit('Add track', [{ op: 'add_track', index: 0 }])} title="New track on top">+ Track</button>
        <div className="spacer" />
        <label className="zoom">Zoom <input type="range" min={10} max={300} value={pps} onChange={(e) => setPps(Number(e.target.value))} /></label>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width: total * pps + 80 }}>
          <div className="ruler" onPointerDown={seekFromEvent} style={{ marginLeft: 64 }}>
            {ticks.map((s) => (
              <span key={s} className="tick" style={{ left: s * pps }}>{Number.isInteger(s) ? `${s}s` : ''}</span>
            ))}
            {annotations.map((a) => (
              <button key={a.id} className={`pin ${a.status}`} style={{ left: a.t * pps }} title={a.note} onPointerDown={(e) => { e.stopPropagation(); onPin(a); }}>●</button>
            ))}
          </div>
          {project.tracks.map((tr) => (
            <div key={tr.index} className="track" style={{ height: ROW }}>
              <div className="track-head">
                <span>T{tr.index + 1}</span>
                <button className={tr.muted ? 'on' : ''} title="Mute" onClick={() => edit(tr.muted ? 'Unmute track' : 'Mute track', [{ op: 'set_track', index: tr.index, muted: !tr.muted }])}>🔈</button>
                <button className={tr.locked ? 'on' : ''} title="Lock (the agent cannot change a locked track)" onClick={() => edit(tr.locked ? 'Unlock track' : 'Lock track', [{ op: 'set_track', index: tr.index, locked: !tr.locked }])}>🔒</button>
              </div>
              <div className="lane" onPointerDown={(e) => { if (e.target === e.currentTarget) { setSelected([]); seekFromEvent(e); } }}>
                {tr.clips.map((c) => {
                  const d = drag?.id === c.id ? drag : null;
                  let left = c.start * pps;
                  let width = ((c.end ?? c.start + 5) - c.start) * pps;
                  let top = 0;
                  if (d?.mode === 'move') { left += d.dt * pps; top = d.dTrack * ROW; }
                  if (d?.mode === 'in') { left += d.dt * pps; width -= d.dt * pps; }
                  if (d?.mode === 'out') width += d.dt * pps;
                  const name = c.src.split('/').pop()!.replace(/\.[^.]+$/, '');
                  return (
                    <div
                      key={c.id}
                      className={`clip ${KIND_COLOR[c.kind] ?? ''} ${selected.includes(c.id) ? 'sel' : ''} ${changed.has(c.id) ? 'changed' : ''} ${c.disabled ? 'off' : ''}`}
                      style={{ left, width: Math.max(6, width), transform: `translateY(${top}px)` }}
                      title={`${c.id} · ${c.src}\n${c.start.toFixed(2)}–${c.end?.toFixed(2)} s · source ${c.in}–${c.out ?? '…'}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelected(e.shiftKey ? [...new Set([...selected, c.id])] : [c.id]);
                        if (tr.locked) return;
                        setDrag({ id: c.id, mode: 'move', x0: e.clientX, y0: e.clientY, clip: c, track: tr.index, dt: 0, dTrack: 0 });
                      }}
                    >
                      <span className="h in" onPointerDown={(e) => { e.stopPropagation(); setSelected([c.id]); if (!tr.locked) setDrag({ id: c.id, mode: 'in', x0: e.clientX, y0: e.clientY, clip: c, track: tr.index, dt: 0, dTrack: 0 }); }} />
                      <span className="cname">{name}</span>
                      <span className="h out" onPointerDown={(e) => { e.stopPropagation(); setSelected([c.id]); if (!tr.locked) setDrag({ id: c.id, mode: 'out', x0: e.clientX, y0: e.clientY, clip: c, track: tr.index, dt: 0, dTrack: 0 }); }} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="playhead" style={{ left: 64 + t * pps }} />
        </div>
      </div>
    </div>
  );
}
