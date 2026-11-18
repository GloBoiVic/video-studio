// Local agent harnesses. Each runs the person's own installed CLI (its own sign-in; we never see credentials),
// in the project folder, with the `studio` MCP server as its only way to change the film. Their streams are mapped
// to one event shape, so the chat does not care which agent is talking.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

export type AgentEvent =
  | { kind: 'session'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: unknown }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; ok: boolean; text?: string; cost?: number };

export type ModelChoice = { id: string; label: string };

/** A model name as the CLIs take it: letters, digits, dots, dashes, colons, slashes. */
export const MODEL_ID = /^[A-Za-z0-9][\w.:/-]{0,79}$/;

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };

export type RunOptions = {
  prompt: string;
  cwd: string;
  instructions: string;
  mcp: McpLaunch;
  sessionId?: string;
  readDirs: string[];
  model?: string;
};

export interface Harness {
  id: 'claude' | 'codex';
  label: string;
  detect(): Promise<{ available: boolean; path?: string; why?: string }>;
  /** Models the person can pick; '' (the CLI's own default) is always offered first by the UI. */
  models(): Promise<ModelChoice[]>;
  run(o: RunOptions): AgentRun;
}

/** PATH with the usual places CLIs live, for an app started from the Dock (which gets a bare PATH). */
export function agentPath(): string {
  const extra = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.bun/bin'), join(homedir(), '.npm-global/bin'), '/usr/bin', '/bin'];
  return [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

function which(cmd: string): string | null {
  for (const dir of agentPath().split(delimiter)) {
    const f = join(dir, cmd);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Environment for an agent CLI: the person's, minus anything that would point it at another account or API key. */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: agentPath() };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export class AgentRun extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;
  finished = false;

  start(cmd: string, args: string[], cwd: string, onLine: (j: Record<string, unknown>) => void) {
    const p = spawn(cmd, args, { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    let stderr = '';
    p.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    createInterface({ input: p.stdout! }).on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* not an event */
      }
    });
    p.on('error', (e) => this.finish({ kind: 'done', ok: false, text: `could not start ${cmd}: ${e.message}` }));
    p.on('close', (code) => {
      if (this.stopped) this.finish({ kind: 'done', ok: false, text: 'Stopped.' });
      else if (code === 0) this.finish({ kind: 'done', ok: true });
      else this.finish({ kind: 'done', ok: false, text: stderr.trim().split('\n').filter((l) => !/^WARNING: proceeding/.test(l)).slice(-4).join('\n') || `exited with code ${code}` });
    });
  }

  emitEvent(e: AgentEvent) {
    if (!this.finished) this.emit('event', e);
  }

  finish(e: AgentEvent & { kind: 'done' }) {
    if (this.finished) return;
    this.emitEvent(e);
    this.finished = true;
    this.emit('finished', e);
  }

  stop() {
    if (!this.proc || this.finished) return;
    this.stopped = true;
    this.proc.kill('SIGINT');
    setTimeout(() => this.proc && !this.finished && this.proc.kill('SIGKILL'), 3000);
  }
}

export const claude: Harness = {
  id: 'claude',
  label: 'Claude Code',
  async detect() {
    const path = which('claude');
    return path ? { available: true, path } : { available: false, why: 'Claude Code is not installed (https://claude.com/claude-code)' };
  },
  // Claude Code's own aliases always point at the latest model of each family
  async models() {
    return [
      { id: 'opus', label: 'Opus (most capable)' },
      { id: 'sonnet', label: 'Sonnet (balanced)' },
      { id: 'haiku', label: 'Haiku (fastest)' },
    ];
  },
  run(o) {
    const run = new AgentRun();
    const mcp = JSON.stringify({ mcpServers: { studio: { type: 'stdio', command: o.mcp.command, args: o.mcp.args, env: o.mcp.env } } });
    const args = [
      '-p', o.prompt,
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcp, '--strict-mcp-config',
      // built-in tools: reading and searching only; every change goes through the studio tools
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'mcp__studio', 'Read', 'Glob', 'Grep',
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', o.instructions,
      ...o.readDirs.flatMap((d) => ['--add-dir', d]),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : []),
    ];
    run.start(which('claude') ?? 'claude', args, o.cwd, (j) => {
      if (j.type === 'system' && j.subtype === 'init') {
        run.emitEvent({ kind: 'session', id: String(j.session_id) });
        const servers = (j.mcp_servers as Array<{ name: string; status: string }> | undefined) ?? [];
        const studio = servers.find((s) => s.name === 'studio');
        if (studio && studio.status !== 'connected') run.emitEvent({ kind: 'error', text: `studio tools did not connect (${studio.status})` });
      } else if (j.type === 'assistant') {
        const content = ((j.message as { content?: unknown[] })?.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
        for (const c of content) {
          if (c.type === 'text' && c.text?.trim()) run.emitEvent({ kind: 'text', text: c.text });
          if (c.type === 'tool_use') run.emitEvent({ kind: 'tool', name: String(c.name).replace(/^mcp__studio__/, ''), input: c.input });
        }
      } else if (j.type === 'result') {
        if (j.session_id) run.emitEvent({ kind: 'session', id: String(j.session_id) });
        run.finish({ kind: 'done', ok: !j.is_error, text: j.is_error ? String(j.result ?? j.subtype) : undefined, cost: Number(j.total_cost_usd) || undefined });
      }
    });
    return run;
  },
};

const toml = (s: string) => JSON.stringify(s);

export const codex: Harness = {
  id: 'codex',
  label: 'Codex',
  async detect() {
    const path = which('codex');
    return path ? { available: true, path } : { available: false, why: 'Codex CLI is not installed (https://developers.openai.com/codex)' };
  },
  // the models Codex itself lists, from its cache (only model names are read; never its sign-in files)
  async models() {
    try {
      const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json');
      const cache = JSON.parse(readFileSync(file, 'utf8')) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; priority?: number }> };
      return (cache.models ?? [])
        .filter((m) => m.slug && MODEL_ID.test(m.slug) && m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((m) => ({ id: m.slug!, label: m.display_name ?? m.slug! }));
    } catch {
      return [];
    }
  },
  run(o) {
    const run = new AgentRun();
    const env = `{${Object.entries(o.mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(', ')}}`;
    const common = [
      '--json', '--skip-git-repo-check',
      '-s', 'read-only',
      '-C', o.cwd,
      '-c', `mcp_servers.studio.command=${toml(o.mcp.command)}`,
      '-c', `mcp_servers.studio.args=[${o.mcp.args.map(toml).join(', ')}]`,
      '-c', `mcp_servers.studio.env=${env}`,
      '-c', 'mcp_servers.studio.tool_timeout_sec=600',
      // the studio tools are the app's own checked write path: pre-approved, since exec mode cannot ask (approval "never")
      '-c', 'mcp_servers.studio.default_tools_approval_mode="approve"',
      '-c', 'approval_policy="never"',
      ...(o.model ? ['-m', o.model] : []),
    ];
    // Codex has no separate system prompt flag in exec mode: the instructions lead the first message of a session.
    const prompt = o.sessionId ? o.prompt : `${o.instructions}\n\n---\n\n${o.prompt}`;
    const args = o.sessionId ? ['exec', ...common, 'resume', o.sessionId, prompt] : ['exec', ...common, prompt];
    run.start(which('codex') ?? 'codex', args, o.cwd, (j) => {
      const item = j.item as { type?: string; text?: string; tool?: string; server?: string; arguments?: unknown; command?: string; message?: string } | undefined;
      if (j.type === 'thread.started') run.emitEvent({ kind: 'session', id: String(j.thread_id) });
      else if (j.type === 'item.started' && item?.type === 'mcp_tool_call') run.emitEvent({ kind: 'tool', name: String(item.tool), input: item.arguments });
      else if (j.type === 'item.started' && item?.type === 'command_execution') run.emitEvent({ kind: 'tool', name: 'shell', input: item.command });
      else if (j.type === 'item.completed' && item?.type === 'agent_message' && item.text) run.emitEvent({ kind: 'text', text: item.text });
      else if (j.type === 'item.completed' && item?.type === 'error') run.emitEvent({ kind: 'error', text: String(item.message) });
      else if (j.type === 'turn.failed') run.finish({ kind: 'done', ok: false, text: String((j.error as { message?: string })?.message ?? 'turn failed') });
      else if (j.type === 'turn.completed') run.finish({ kind: 'done', ok: true });
      else if (j.type === 'error') run.emitEvent({ kind: 'error', text: String(j.message) });
    });
    return run;
  },
};

export const HARNESSES: Record<string, Harness> = { claude, codex };
