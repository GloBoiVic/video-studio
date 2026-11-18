import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, events, native, fmt, type Annotation, type Shape, type State } from './api';
import { Preview, type PreviewHandle } from './Preview';
import { Timeline } from './Timeline';
import { Chat } from './Chat';

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [toast, setToast] = useState<{ kind: string; text: string } | null>(null);
  useEffect(() => events((m) => {
    if (m.type === 'hello') setState(m.data);
    else if (m.type === 'project') setState((s) => s && { ...s, project: m.data.project, chat: m.data.chat, exports: m.data.exports, recent: m.data.recent });
    else if (m.type === 'change') setState((s) => s && { ...s, project: m.data.project.project });
    else if (m.type === 'chat') setState((s) => s && { ...s, chat: m.data });
    else if (m.type === 'agent') setState((s) => s && { ...s, agentRunning: m.data.running });
    else if (m.type === 'annotations') setState((s) => s && s.project && { ...s, project: { ...s.project, annotations: m.data } });
    else if (m.type === 'media') setState((s) => s && s.project && { ...s, project: { ...s.project, media: m.data } });
    else if (m.type === 'checkpoints') setState((s) => s && s.project && { ...s, project: { ...s.project, checkpoints: m.data } });
    else if (m.type === 'library') setState((s) => s && { ...s, library: m.data });
    else if (m.type === 'export') setState((s) => s && { ...s, exports: [m.data, ...s.exports.filter((j) => j.id !== m.data.id)] });
    else if (m.type === 'toast') setToast(m.data);
    if (m.type === 'change') window.dispatchEvent(new CustomEvent('film-change', { detail: m.data }));
  }), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const fail = (e: unknown) => setToast({ kind: 'error', text: (e as Error).message });
  if (!state) return <div className="boot">Starting…</div>;
  return (
    <>
      {state.project ? <Editor state={state} fail={fail} /> : <Welcome state={state} fail={fail} />}
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.text}</div>}
    </>
  );
}

function Welcome({ state, fail }: { state: State; fail(e: unknown): void }) {
  const [name, setName] = useState('');
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Video Studio</h1>
        <p className="sub">You direct. A local agent edits. Everything stays on this Mac.</p>
        <form onSubmit={(e) => { e.preventDefault(); api('project/create', { name: name || 'Untitled' }).catch(fail); }}>
          <input autoFocus placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary">Create project</button>
        </form>
        <button className="ghost" onClick={async () => {
          const p = native ? await native.pickFolder() : prompt('Project folder path');
          if (p) api('project/open', { path: p }).catch(fail);
        }}>Open a project folder…</button>
        {state.recent.length > 0 && (
          <div className="recent">
            <h3>Recent</h3>
            {state.recent.map((r) => (
              <button key={r.path} className="recent-row" onClick={() => api('project/open', { path: r.path }).catch(fail)}>
                <b>{r.name}</b><span>{r.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ state, fail }: { state: State; fail(e: unknown): void }) {
  const p = state.project!;
  const [t, setTRaw] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [drawing, setDrawing] = useState<Shape[]>([]);
  const [noteFor, setNoteFor] = useState<Shape[] | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const [side, setSide] = useState<'media' | 'library' | 'notes' | 'history'>('media');
  const [showExport, setShowExport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const preview = useRef<PreviewHandle>(null);
  const prevIds = useRef(new Map<string, string>());

  const setT = useCallback((x: number) => setTRaw(Math.max(0, x)), []);

  // tell the server where the person is looking, for the agent's context
  useEffect(() => {
    const id = setTimeout(() => api('playhead', { t, selection: { clips: selected } }).catch(() => undefined), 250);
    return () => clearTimeout(id);
  }, [t, selected]);

  // highlight what an agent edit changed; reload the preview when pages changed
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { graphics?: string[] };
      if (d.graphics?.length) setReloadKey((k) => k + 1);
    };
    addEventListener('film-change', on);
    return () => removeEventListener('film-change', on);
  }, []);
  useEffect(() => {
    const now = new Map(p.tracks.flatMap((tr) => tr.clips.map((c) => [c.id, `${tr.index}|${JSON.stringify(c)}`] as const)));
    const diff = new Set<string>();
    for (const [id, v] of now) if (prevIds.current.size && prevIds.current.get(id) !== v) diff.add(id);
    prevIds.current = now;
    const last = p.history.undo.at(-1);
    if (diff.size && last?.author === 'agent') {
      setChanged(diff);
      const id = setTimeout(() => setChanged(new Set()), 4000);
      return () => clearTimeout(id);
    }
  }, [p.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = useCallback(async (label: string, commands: unknown[]) => {
    try {
      await api('edit', { label, commands, expectedRevision: p.revision });
    } catch (e) {
      fail(e);
    }
  }, [p.revision, fail]);

  // keyboard
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === ' ') { e.preventDefault(); preview.current?.toggle(); }
      else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); api(e.shiftKey ? 'redo' : 'undo', {}).catch(fail); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && selected.length) edit('Delete', selected.map((id) => ({ op: 'remove_clip', id })));
      else if (e.key === 's' && selected[0]) edit('Split', [{ op: 'split_clip', id: selected[0], at: t }]);
      else if (e.key === 'ArrowLeft') setT(t - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'ArrowRight') setT(t + (e.shiftKey ? 1 : 1 / 30));
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [selected, t, edit, fail, setT]);

  const onScreen = useMemo(() => p.tracks.flatMap((tr) => (tr.hidden ? [] : tr.clips.filter((c) => !c.disabled && c.start <= t && (c.end ?? Infinity) > t).map((c) => c.id))), [p.tracks, t]);

  const importFiles = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      await api('import', { paths });
    } catch (e) {
      fail(e);
    }
  };
  const addToTimeline = (src: string, duration: number | null) => {
    // first track (from the bottom) with room at the playhead, else a new bottom track
    const len = duration ?? 5;
    const free = [...p.tracks].reverse().find((tr) => tr.clips.every((c) => (c.end ?? Infinity) <= t || c.start >= t + len));
    edit(`Add ${src.split('/').pop()}`, [{ op: 'add_clip', src, track: free ? free.index : p.tracks.length, at: Math.round(t * 30) / 30 }]);
  };
  const running = state.exports.find((j) => j.status === 'running');

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (native) importFiles([...e.dataTransfer.files].map((f) => native!.pathForFile(f))); }}>
      <header className="top">
        <div className="brand">Video Studio</div>
        <div className="pname" title={p.root}>{p.name}</div>
        <div className="spacer" />
        <button onClick={() => api('undo', {}).catch(fail)} disabled={!p.history.undo.length} title={p.history.undo.at(-1) ? `Undo: ${p.history.undo.at(-1)!.label}` : 'Undo'}>↶ Undo</button>
        <button onClick={() => api('redo', {}).catch(fail)} disabled={!p.history.redo.length} title="Redo">↷ Redo</button>
        <button onClick={() => api('checkpoint', { label: prompt('Name this checkpoint', `Checkpoint ${p.checkpoints.length + 1}`) ?? 'Checkpoint' }).catch(fail)}>⚑ Checkpoint</button>
        <button className="primary" onClick={() => setShowExport(true)}>{running ? `Exporting ${Math.round((running.frame / running.frames) * 100)}%` : 'Export'}</button>
      </header>

      <aside className="side">
        <nav className="tabs">
          {(['media', 'library', 'notes', 'history'] as const).map((k) => (
            <button key={k} className={side === k ? 'on' : ''} onClick={() => setSide(k)}>
              {k === 'media' ? 'Media' : k === 'library' ? 'Library' : k === 'notes' ? `Notes${p.annotations.filter((a) => a.status === 'open').length ? ` (${p.annotations.filter((a) => a.status === 'open').length})` : ''}` : 'History'}
            </button>
          ))}
        </nav>
        {side === 'media' && (
          <div className="panel">
            <button className="primary wide" onClick={async () => importFiles(native ? await native.pickFiles() : (prompt('Paths to import (comma separated)') ?? '').split(',').map((s) => s.trim()).filter(Boolean))}>+ Import media</button>
            <p className="hint">Files are copied into the project and kept read-only. Drop files anywhere.</p>
            {p.media.map((m) => (
              <div key={m.src} className="media-row">
                <span className={`kind k-${m.kind}`}>{m.kind}</span>
                <span className="mname" title={m.src}>{m.src.replace('media/', '')}</span>
                <span className="dur">{m.duration ? `${m.duration.toFixed(1)}s` : ''}</span>
                <button onClick={() => addToTimeline(m.src, m.duration)} title="Add at playhead">＋</button>
              </div>
            ))}
            {p.graphics.length > 0 && <h4>Graphics</h4>}
            {p.graphics.map((g) => (
              <div key={g.src} className="media-row">
                <span className="kind k-graphic">gfx</span>
                <span className="mname">{g.src.replace('graphics/', '')}</span>
                <button onClick={() => addToTimeline(g.src, g.duration)} title="Add at playhead">＋</button>
              </div>
            ))}
          </div>
        )}
        {side === 'library' && <LibraryPanel state={state} t={t} fail={fail} />}
        {side === 'notes' && (
          <div className="panel">
            {p.annotations.length === 0 && <p className="hint">Use Mark up under the preview to circle or point at something, then add a note.</p>}
            {[...p.annotations].reverse().map((a) => (
              <div key={a.id} className={`note ${a.status}`}>
                <div className="note-top"><button className="link" onClick={() => setT(a.t)}>{fmt(a.t)}</button><span className={`status ${a.status}`}>{a.status}</span></div>
                {a.image && <img src={`/api/annotation-image?id=${a.id}&token=${encodeURIComponent(sessionStorage.getItem('studio-token') ?? '')}&v=${a.status}`} alt="" />}
                <div>{a.note}</div>
                {a.resolution && <div className="resolution">✓ {a.resolution}</div>}
                <div className="note-actions">
                  {a.status === 'open' && <button onClick={() => setAttached([...new Set([...attached, a.id])])}>Send to agent</button>}
                  <button onClick={() => api('annotation', { id: a.id, status: a.status === 'open' ? 'resolved' : 'open' }).catch(fail)}>{a.status === 'open' ? 'Resolve' : 'Reopen'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {side === 'history' && (
          <div className="panel">
            <h4>Edits</h4>
            {[...p.history.undo].reverse().slice(0, 60).map((h) => (
              <div key={h.revision} className="hist"><span className={`by ${h.author}`}>{h.author === 'agent' ? 'agent' : h.author === 'person' ? 'you' : 'app'}</span>{h.label}</div>
            ))}
            <h4>Checkpoints</h4>
            {[...p.checkpoints].reverse().map((c) => (
              <div key={c.id} className="hist"><span>{c.label}</span><button className="link" onClick={() => api('restore', { id: c.id }).catch(fail)}>Restore</button></div>
            ))}
          </div>
        )}
      </aside>

      <main className="center">
        <Preview ref={preview} project={p} t={t} setT={setT} drawing={drawing} setDrawing={setDrawing} onAnnotate={(s) => setNoteFor(s)} reloadKey={reloadKey} />
      </main>

      <section className="right">
        <Chat chat={state.chat} running={state.agentRunning} attached={attached} setAttached={setAttached} annotations={p.annotations} onRestore={(id) => api('restore', { id }).catch(fail)} />
      </section>

      <footer className="bottom">
        <Timeline project={p} t={t} setT={setT} selected={selected} setSelected={setSelected} edit={edit} annotations={p.annotations} changed={changed} onPin={(a) => { setT(a.t); setSide('notes'); }} />
      </footer>

      {noteFor && (
        <NoteDialog
          t={t}
          clips={onScreen}
          onCancel={() => setNoteFor(null)}
          onSave={async (note, send) => {
            try {
              const a = await api<Annotation>('annotate', { t, clips: onScreen, shapes: noteFor, note });
              setNoteFor(null);
              setDrawing([]);
              if (send) setAttached([...new Set([...attached, a.id])]);
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
      {showExport && <ExportDialog state={state} onClose={() => setShowExport(false)} fail={fail} />}
    </div>
  );
}

function NoteDialog({ t, clips, onCancel, onSave }: { t: number; clips: string[]; onCancel(): void; onSave(note: string, send: boolean): void }) {
  const [note, setNote] = useState('');
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>Note at {fmt(t)}</h3>
        <p className="hint">On screen: {clips.join(', ') || 'nothing'}</p>
        <textarea autoFocus rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong here, or what should change?" />
        <div className="row">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button onClick={() => onSave(note, false)} disabled={!note.trim()}>Save note</button>
          <button className="primary" onClick={() => onSave(note, true)} disabled={!note.trim()}>Save & attach to chat</button>
        </div>
      </div>
    </div>
  );
}

function LibraryPanel({ state, t, fail }: { state: State; t: number; fail(e: unknown): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  return (
    <div className="panel">
      <p className="hint">Reusable graphics, kept across projects. The agent can add and save these too.</p>
      {state.library.map((tpl) => (
        <div key={tpl.id} className="tpl">
          <div className="tpl-top" onClick={() => { setOpen(open === tpl.id ? null : tpl.id); setVals({}); }}>
            <b>{tpl.name}</b><span className="src">{tpl.source === 'user' ? 'yours' : 'built-in'}</span>
          </div>
          {open === tpl.id && (
            <div className="tpl-form">
              <p className="hint">{tpl.description}</p>
              {Object.entries(tpl.params).map(([k, prm]) => (
                <label key={k}>{prm.label ?? k}<input value={vals[k] ?? ''} placeholder={String(prm.default ?? '')} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
              ))}
              <button className="primary" onClick={() => {
                const params = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== ''));
                api('library/add', { template: tpl.id, params, track: 0, at: Math.round(t * 30) / 30 }).catch(fail);
              }}>Add at {t.toFixed(2)} s (top track)</button>
            </div>
          )}
        </div>
      ))}
      <h4>Brand</h4>
      {Object.entries(state.brand).map(([k, v]) => (
        <div key={k} className="brand-row"><span className="swatch" style={{ background: v }} /><span>{k}</span><code>{v}</code></div>
      ))}
    </div>
  );
}

function ExportDialog({ state, onClose, fail }: { state: State; onClose(): void; fail(e: unknown): void }) {
  const tok = encodeURIComponent(sessionStorage.getItem('studio-token') ?? '');
  const running = state.exports.find((j) => j.status === 'running');
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>Export</h3>
        {!state.canRender && <p className="err">Exporting needs the desktop app.</p>}
        <div className="row">
          <button className="primary" disabled={!!running || !state.canRender} onClick={() => api('export', { preset: '1080p' }).catch(fail)}>1080p MP4</button>
          <button className="primary" disabled={!!running || !state.canRender} onClick={() => api('export', { preset: '4k' }).catch(fail)}>4K MP4</button>
          {running && <button className="ghost" onClick={() => api('export/cancel', {})}>Cancel</button>}
        </div>
        {state.exports.map((j) => (
          <div key={j.id} className="job">
            <div><b>{j.preset}</b> · {j.status === 'running' ? `${j.phase} ${j.frame}/${j.frames}` : j.status}{j.seconds ? ` · ${j.seconds.toFixed(1)} s` : ''}</div>
            {j.status === 'running' && <progress max={j.frames} value={j.frame} />}
            {j.error && <div className="err">{j.error}</div>}
            {j.status === 'done' && (
              <>
                <video controls src={`/api/export-file?id=${j.id}&token=${tok}`} />
                <div className="row">
                  <code className="path">{j.out}</code>
                  {native && <button onClick={() => native!.reveal(j.out!)}>Show in Finder</button>}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
