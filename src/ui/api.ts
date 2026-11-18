import type { Film } from '../core/types';

export type ClipView = { id: string; src: string; kind: string; start: number; end: number | null; in: number; out: number | null; speed?: number; volume?: number; box?: unknown; disabled?: boolean; overrides?: unknown };
export type TrackView = { index: number; locked: boolean; hidden: boolean; muted: boolean; clips: ClipView[] };
export type Annotation = { id: string; t: number; clips: string[]; shapes: Shape[]; note: string; status: 'open' | 'resolved'; resolution?: string; image?: string; createdAt: string };
export type Shape =
  | { kind: 'circle'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pen'; points: Array<[number, number]> };
export type Project = {
  root: string;
  name: string;
  revision: number;
  stage: { w: number; h: number };
  duration: number;
  tracks: TrackView[];
  film: Film;
  media: Array<{ src: string; kind: string; duration: number | null; width?: number; height?: number }>;
  graphics: Array<{ src: string; duration: number | null; template?: string }>;
  history: { undo: Array<{ revision: number; label: string; author: string; at: string }>; redo: Array<{ label: string }> };
  checkpoints: Array<{ id: string; label: string; revision: number; at: string }>;
  annotations: Annotation[];
  access: { readRoots: string[] };
  previewOrigin: string;
};
export type ChatMessage = { id: string; role: 'person' | 'agent' | 'system'; harness?: string; model?: string; text: string; at: string; status?: string; checkpointId?: string; annotationIds?: string[]; tools?: Array<{ name: string; ok?: boolean; summary?: string }>; cost?: number };
export type Template = { id: string; name: string; description: string; duration: number | null; params: Record<string, { type: string; label?: string; default?: string | number }>; source: string };
export type ExportJob = { id: string; preset: string; status: string; frame: number; frames: number; phase: string; out?: string; error?: string; seconds?: number };
export type State = {
  project: Project | null;
  chat: ChatMessage[];
  agentRunning: boolean;
  exports: ExportJob[];
  library: Template[];
  brand: Record<string, string>;
  recent: Array<{ path: string; name: string }>;
  canRender: boolean;
};
export type Native = { pickFiles(): Promise<string[]>; pickFolder(): Promise<string | null>; reveal(p: string): Promise<void>; pathForFile(f: File): string };
export const native: Native | undefined = (window as unknown as { studioNative?: Native }).studioNative;

const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) {
  sessionStorage.setItem('studio-token', fromHash);
  history.replaceState(null, '', location.pathname);
}
export const token = sessionStorage.getItem('studio-token') ?? '';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function events(on: (m: { type: string; data: any }) => void) {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => on(JSON.parse(e.data));
  return () => es.close();
}

export const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
