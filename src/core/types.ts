// Shared types for the project model. The film itself is OpenFilm's film.html (see openfilm/SPEC.md);
// everything the editor adds lives beside it in `.studio/`.

export type Box = { x: number; y: number; w?: number; h?: number; r?: number };

export type Clip = {
  id: string;
  src: string;
  at?: number;
  time?: [number] | [number, number];
  box?: Box;
  volume?: number;
  speed?: number;
  class?: string;
  style?: string;
  disabled?: true;
  sound?: true;
  size?: { w: number; h: number };
  overrides?: Array<Record<string, unknown>>;
  attrs?: Record<string, string>;
};

export type Track = {
  clips: Clip[];
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  attrs?: Record<string, string>;
  captions?: unknown;
};

export type Film = { stage: { w: number; h: number }; tracks: Track[] };

export type Author = 'person' | 'agent' | 'system';

export type MediaInfo = {
  /** path relative to the project, e.g. media/interview.mp4 */
  src: string;
  kind: 'video' | 'still' | 'sound';
  duration: number | null;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  sha256: string;
  importedFrom: string;
  importedAt: string;
};

export type GraphicInfo = {
  src: string;
  duration: number | null;
  template?: string;
  params?: Record<string, unknown>;
};

export type Shape =
  | { kind: 'circle'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pen'; points: Array<[number, number]> };

export type Annotation = {
  id: string;
  /** film time the note is about, seconds */
  t: number;
  /** optional time range the note covers */
  range?: [number, number];
  /** clips on screen at t, top first */
  clips: string[];
  shapes: Shape[];
  note: string;
  status: 'open' | 'resolved';
  resolution?: string;
  createdAt: string;
  /** frame + drawing as PNG, relative to the project (.studio/annotations/<id>.png) */
  image?: string;
};

export type HistoryEntry = {
  revision: number;
  label: string;
  author: Author;
  at: string;
};

export type Checkpoint = { id: string; label: string; revision: number; at: string; author: Author };
