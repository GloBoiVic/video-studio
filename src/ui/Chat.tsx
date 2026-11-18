// The agent chat: pick a local agent, talk to it, watch its tool calls, stop it, or take the film back to before
// any of its turns.
import { useEffect, useRef, useState } from 'react';
import { api, type Annotation, type ChatMessage } from './api';

/** **bold** and `code` in agent replies, as elements (never as HTML). */
function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}

type AgentInfo = { id: string; label: string; available: boolean; why?: string };

export function Chat({ chat, running, attached, setAttached, annotations, onRestore }: {
  chat: ChatMessage[];
  running: boolean;
  attached: string[];
  setAttached(ids: string[]): void;
  annotations: Annotation[];
  onRestore(checkpointId: string): void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [harness, setHarness] = useState(() => localStorage.getItem('harness') ?? 'claude');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<AgentInfo[]>('agents').then(setAgents).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [chat]);

  const send = async () => {
    if (!text.trim() || running) return;
    setErr('');
    try {
      await api('agent/send', { harness, text, annotationIds: attached });
      setText('');
      setAttached([]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const current = agents.find((a) => a.id === harness);

  return (
    <div className="chat">
      <div className="chat-head">
        <select value={harness} onChange={(e) => { setHarness(e.target.value); localStorage.setItem('harness', e.target.value); }} aria-label="Agent">
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>{a.label}{a.available ? '' : ' (not installed)'}</option>
          ))}
        </select>
        <button className="ghost" onClick={() => api('agent/new', { harness })} disabled={running} title="Start a fresh conversation (keeps the film)">New chat</button>
      </div>
      <div className="messages" ref={list}>
        {chat.length === 0 && (
          <div className="empty">
            <p><b>You direct, the agent edits.</b></p>
            <p>Try: “Make a rough cut from the interview, add a lower third for the speaker, then look at it.”</p>
            <p>Circle a mistake on the preview with Mark up, add a note, and send it here.</p>
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.status ?? ''}`}>
            {m.role === 'agent' && <div className="who">{m.harness === 'codex' ? 'Codex' : 'Claude Code'}{m.status === 'running' ? ' · working…' : m.status === 'stopped' ? ' · stopped' : m.status === 'error' ? ' · error' : ''}</div>}
            {m.annotationIds && m.annotationIds.length > 0 && <div className="chips">{m.annotationIds.map((id) => <span key={id} className="chip">📍 {id}</span>)}</div>}
            {m.text && <div className="text">{rich(m.text)}</div>}
            {m.tools && m.tools.length > 0 && (
              <div className="toolcalls">
                {m.tools.map((t, i) => (
                  <span key={i} className={`tc ${t.ok === false ? 'bad' : ''}`} title={t.summary}>{t.name}</span>
                ))}
              </div>
            )}
            {m.role === 'agent' && m.checkpointId && m.status !== 'running' && (
              <button className="link" onClick={() => onRestore(m.checkpointId!)} title="Restore the film to how it was before this request (undoable)">↶ Undo this turn</button>
            )}
          </div>
        ))}
      </div>
      {attached.length > 0 && (
        <div className="chips attach">
          {attached.map((id) => {
            const a = annotations.find((x) => x.id === id);
            return (
              <span key={id} className="chip">📍 {a ? `${a.t.toFixed(1)}s ${a.note.slice(0, 30)}` : id} <button onClick={() => setAttached(attached.filter((x) => x !== id))}>×</button></span>
            );
          })}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={current?.available === false ? current.why : 'Tell the agent what to do…'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          rows={3}
        />
        {running ? <button className="stop" onClick={() => api('agent/stop', {})}>Stop</button> : <button className="primary" onClick={send} disabled={!text.trim()}>Send</button>}
      </div>
    </div>
  );
}
