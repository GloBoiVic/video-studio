// End-to-end self-test, run inside the real app (VIDEO_STUDIO_SELFTEST=<report.json>). It drives the same path an
// agent does (the stdio MCP server, the agent token, the tools) with a scripted "agent", annotates a mistake, has it
// fixed, checks undo/checkpoints, saves a template and reuses it in a second project, exports 1080p and 4K, and
// checks the exported files and pixels. Optionally (VIDEO_STUDIO_SELFTEST_AGENT=claude|codex) it then asks a real
// agent to make an edit and fix an annotation.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Studio } from '../server/studio.js';

type Check = { name: string; ok: boolean; detail?: unknown; ms: number };

export async function runSelfTest(studio: Studio, { reportFile, appRoot }: { reportFile: string; appRoot: string }) {
  const checks: Check[] = [];
  const t00 = Date.now();
  const report = () => writeFileSync(reportFile, JSON.stringify({ ok: checks.every((c) => c.ok), seconds: (Date.now() - t00) / 1000, checks }, null, 2));
  const check = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail, ms: Date.now() - t0 });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error).stack ?? e), ms: Date.now() - t0 });
    }
    report();
  };
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  const work = join(reportFile, '..', 'selftest-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const footA = join(work, 'Interview A.mp4');
  const footB = join(work, 'B-roll.mp4');

  await check('make test footage', () => {
    const mk = (out: string, src: string, d: number, f: number) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=1920x1080:rate=30:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
    mk(footA, 'testsrc2', 8, 440);
    mk(footB, 'smptebars', 5, 660);
    return { footA, footB };
  });

  await check('create project and import media (read-only)', async () => {
    await studio.create(`Selftest ${Date.now().toString(36)}`, join(work, 'projects'));
    const s = studio.need();
    const a = await s.importMedia(footA);
    const b = await s.importMedia(footB);
    assert(a.duration && b.duration, 'durations probed');
    let writable = true;
    try {
      writeFileSync(join(s.root, a.src), 'x', { flag: 'r+' });
    } catch {
      writable = false;
    }
    assert(!writable, 'imported media must be read-only');
    return { root: s.root, media: [a.src, b.src] };
  });

  // ---- the agent's path: MCP stdio server -> app API (agent token) -> tools -> store ----
  studio.agentToken = randomBytes(16).toString('hex');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(appRoot, 'dist', 'mcp.js')],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1', STUDIO_API: studio.origin, STUDIO_AGENT_TOKEN: studio.agentToken },
    stderr: 'pipe',
  });
  let mcpErr = '';
  transport.stderr?.on('data', (d) => (mcpErr = (mcpErr + d).slice(-4000)));
  transport.onclose = () => mcpErr && writeFileSync(join(work, 'mcp-stderr.txt'), mcpErr);
  const mcp = new Client({ name: 'selftest-agent', version: '0' });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
    if (r.isError) throw new Error(`${name}: ${r.content.map((c) => c.text).join(' ')}`);
    return r;
  };
  const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content.find((c) => c.type === 'text')!.text!);
  const pngs = (r: { content: Array<{ type: string; data?: string }> }) => r.content.filter((c) => c.type === 'image').map((c) => Buffer.from(c.data!, 'base64'));

  await check('agent connects over MCP and lists tools', async () => {
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    assert(tools.length >= 10, 'tools listed');
    return tools.map((t) => t.name);
  });

  let rev = 0;
  await check('agent makes a rough cut (one undo step)', async () => {
    const p = json(await tool('get_project'));
    rev = p.revision;
    const [a, b] = p.media;
    const r = json(await tool('apply_edits', {
      label: 'Rough cut',
      expected_revision: rev,
      commands: [
        { op: 'add_clip', src: a.src, track: 0, at: 0, in: 1, out: 5, id: 'interview' },
        { op: 'add_clip', src: b.src, track: 0, at: 4, in: 0, out: 3, id: 'broll', fade: [0, 0.5] },
      ],
    }));
    rev = r.revision;
    assert(studio.need().duration() === 7, `film is 7 s (got ${studio.need().duration()})`);
    return r;
  });

  await check('a stale agent write is refused', async () => {
    let refused = '';
    try {
      await tool('apply_edits', { label: 'stale', expected_revision: rev - 1, commands: [{ op: 'remove_clip', id: 'broll' }] });
    } catch (e) {
      refused = String((e as Error).message);
    }
    assert(/changed since you read it/.test(refused), 'stale revision refused');
    return refused;
  });

  await check('agent adds the lower-third template (with a deliberate typo, at the wrong time)', async () => {
    rev = json(await tool('apply_edits', { label: 'Top track for graphics', expected_revision: rev, commands: [{ op: 'add_track', index: 0 }] })).revision;
    const r = json(await tool('add_template_graphic', { template: 'lower-third', params: { name: 'Ada Lovelase', title: 'Mathematician' }, name: 'ada-name', track: 0, at: 0.2, duration: 3.5, expected_revision: rev }));
    rev = r.revision;
    return r;
  });

  await check('agent looks at its work (frames as PNG)', async () => {
    const r = await tool('look', { times: [0.5, 2, 5], width: 640 });
    const imgs = pngs(r);
    imgs.forEach((b, i) => writeFileSync(join(work, `look-${i}.png`), b));
    const info = { types: r.content.map((c) => c.type), sizes: imgs.map((b) => b.length), magic: imgs.map((b) => b.subarray(0, 4).toString('hex')) };
    assert(imgs.length === 3 && imgs.every((b) => b.subarray(1, 4).toString() === 'PNG' && b.length > 2000), `three PNG frames: ${JSON.stringify(info)}`);
    return info;
  });

  let annId = '';
  await check('person annotates the mistake on the frame', async () => {
    const ann = await studio.annotate({ t: 2, clips: ['ada-name', 'interview'], note: 'Name is misspelled: it is Lovelace. Also bring this in at 1 s, not 0.2 s.', shapes: [{ kind: 'circle', cx: 330, cy: 880, rx: 300, ry: 110 }, { kind: 'arrow', x1: 900, y1: 600, x2: 560, y2: 820 }] });
    annId = ann.id;
    assert(ann.image && existsSync(join(studio.need().root, ann.image)), 'annotation image drawn');
    return ann;
  });

  await check('agent reads the annotation (with image) and fixes it', async () => {
    const r = await tool('get_annotations');
    const list = json(r);
    assert(list.length === 1 && list[0].id === annId, 'annotation listed');
    assert(pngs(r).length === 1, 'annotation image sent to the agent');
    const page = await tool('read_graphic', { src: 'graphics/ada-name.html' });
    const html = page.content[0].text!.replace('Ada Lovelase', 'Ada Lovelace');
    const p = json(await tool('get_project'));
    const fixed = json(await tool('write_graphic', { name: 'ada-name', html, duration: 3.5, expected_revision: p.revision }));
    const moved = json(await tool('apply_edits', { label: 'Lower third at 1 s', expected_revision: fixed.revision, commands: [{ op: 'update_clip', id: 'ada-name', at: 1 }] }));
    rev = moved.revision;
    await tool('resolve_annotation', { id: annId, resolution: 'Fixed the spelling (Lovelace) and moved the lower third to 1 s.' });
    const s = studio.need();
    assert(readFileSync(join(s.root, 'graphics/ada-name.html'), 'utf8').includes('Ada Lovelace'), 'spelling fixed on disk');
    assert(s.summary().tracks[0].clips[0].start === 1, 'moved to 1 s');
    assert(s.annotations[0].status === 'resolved', 'resolved');
    return { revision: rev };
  });

  await check('checkpoint restore and undo bring the film back', async () => {
    const s = studio.need();
    const cp = await s.checkpoint('Before a bad agent turn', 'system');
    const before = readFileSync(join(s.root, 'film.html'), 'utf8');
    await tool('apply_edits', { label: 'Bad idea', expected_revision: s.revision, commands: [{ op: 'remove_clip', id: 'broll' }, { op: 'remove_clip', id: 'ada-name' }] });
    assert(!readFileSync(join(s.root, 'film.html'), 'utf8').includes('broll'), 'bad edit applied');
    await s.restore(cp.id);
    assert(readFileSync(join(s.root, 'film.html'), 'utf8') === before, 'restored exactly');
    await s.undo();
    assert(!readFileSync(join(s.root, 'film.html'), 'utf8').includes('id="broll"'), 'undo of the restore brings the bad state back');
    await s.redo();
    assert(readFileSync(join(s.root, 'film.html'), 'utf8') === before, 'redo restores again');
    return { revision: s.revision, steps: s.history().undo.length };
  });

  await check('agent saves the graphic as a reusable template; a second project uses it', async () => {
    const r = json(await tool('save_template', { src: 'graphics/ada-name.html', id: 'selftest-name-card', name: 'Selftest name card', params: { name: { type: 'text', default: 'Ada Lovelace' }, title: { type: 'text', default: 'Mathematician' } } }));
    const first = studio.need().root;
    await studio.create(`Second ${Date.now().toString(36)}`, join(work, 'projects'));
    const s2 = studio.need();
    const out = studio.library.render('selftest-name-card', { name: 'Grace Hopper' });
    const w = await s2.writeGraphic({ name: 'grace', html: out.html, duration: out.duration, author: 'person' });
    assert(readFileSync(join(s2.root, w.src), 'utf8').includes('Grace Hopper'), 'template filled in the second project');
    await studio.open(first);
    return { saved: r.saved.id, secondProject: s2.root };
  });

  const exports: Record<string, string> = {};
  const runExport = (preset: '1080p' | '4k') =>
    new Promise<string>((done, fail) => {
      const job = studio.startExport(preset, 30);
      const on = (m: { type: string; data: { id: string; status: string; out?: string; error?: string } }) => {
        if (m.type !== 'export' || m.data.id !== job.id) return;
        if (m.data.status === 'done') {
          studio.off('push', on);
          done(m.data.out!);
        } else if (m.data.status === 'error') {
          studio.off('push', on);
          fail(new Error(m.data.error));
        }
      };
      studio.on('push', on);
    });
  const ffprobe = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate', '-of', 'json', f], { encoding: 'utf8' }));
  const pixel = (f: string, t: number, x: number, y: number) => {
    // a 2x2 block at even coordinates (4:2:0 video has no 1-pixel chroma)
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return [raw[0], raw[1], raw[2]];
  };
  const near = (p: number[], q: number[], tol = 45) => p.every((v, i) => Math.abs(v - q[i]) <= tol);

  for (const preset of ['1080p', '4k'] as const) {
    await check(`export ${preset} and verify the file`, async () => {
      const t0 = Date.now();
      const out = await runExport(preset);
      exports[preset] = out;
      const p = ffprobe(out);
      const v = p.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      const a = p.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
      const [W, H] = preset === '4k' ? [3840, 2160] : [1920, 1080];
      assert(v.width === W && v.height === H, `size ${v.width}x${v.height}`);
      assert(Math.abs(Number(p.format.duration) - 7) < 0.15, `duration ${p.format.duration}`);
      assert(a && a.codec_name === 'aac', 'has AAC sound');
      const k = W / 1920;
      // the lower third's accent stripe (left 6vw, bottom of the bar ~ 900 px) is drawn at 2 s, not at 0.5 s
      const at2 = pixel(out, 2.0, Math.round(119 * k), Math.round(905 * k));
      const at05 = pixel(out, 0.5, Math.round(119 * k), Math.round(905 * k));
      // the B-roll (SMPTE bars, white-ish top-left bar) is on screen at 5.5 s
      const bars = pixel(out, 5.5, Math.round(100 * k), Math.round(100 * k));
      assert(near(at2, [255, 90, 54]), `accent stripe at 2 s is ${at2}`);
      assert(!near(at05, [255, 90, 54]), `no lower third at 0.5 s (got ${at05})`);
      assert(bars[0] > 150 && bars[1] > 150 && bars[2] > 150, `B-roll bars at 5.5 s (got ${bars})`);
      return { out, seconds: (Date.now() - t0) / 1000, video: v, audio: a?.codec_name, duration: p.format.duration, at2, at05, bars };
    });
  }

  await check('raw media unchanged after all of it', async () => {
    const s = studio.need();
    const { sha256File } = await import('../core/media.js');
    for (const m of Object.values(s.media)) assert((await sha256File(join(s.root, m.src))) === m.sha256, `${m.src} unchanged`);
    return Object.keys(s.media);
  });

  await mcp.close().catch(() => undefined);
  studio.agentToken = '';

  // ---- optional: a real agent, through its own CLI ----
  const harness = process.env.VIDEO_STUDIO_SELFTEST_AGENT;
  // tests run on the cheapest capable model of each agent, never the most expensive (override: VIDEO_STUDIO_SELFTEST_MODEL)
  const TEST_MODELS: Record<string, string> = { codex: 'gpt-6-luna', claude: 'haiku' };
  const model = process.env.VIDEO_STUDIO_SELFTEST_MODEL || (harness ? TEST_MODELS[harness] : undefined);
  if (harness) {
    const waitTurn = () =>
      new Promise<void>((done) => {
        const on = (m: { type: string; data: { running?: boolean } }) => {
          if (m.type === 'agent' && m.data.running === false) {
            studio.off('push', on);
            done();
          }
        };
        studio.on('push', on);
      });
    await check(`live ${harness}: the agent edits the timeline`, async () => {
      const s = studio.need();
      const r0 = s.revision;
      const wait = waitTurn();
      await studio.send({ harness, model, text: 'Add a lower third from the library for "Grace Hopper", title "Computer scientist", from 4.2 s for 2.5 s on the top track. Then look at 5 s to check it.' });
      await wait;
      const reply = studio.chat.at(-1)!;
      assert(reply.status === 'done', `turn ended ${reply.status}: ${reply.text}`);
      assert(s.revision > r0, 'the agent changed the film');
      assert(JSON.stringify(s.film).includes('lower-third') || Object.values(s.graphics).some((g) => JSON.stringify(g.params ?? {}).includes('Grace')), 'a lower third for Grace was added');
      return { reply: reply.text, tools: reply.tools, revision: s.revision };
    });
    await check(`live ${harness}: the agent fixes an annotation`, async () => {
      const s = studio.need();
      const grace = Object.values(s.graphics).find((g) => JSON.stringify(g.params ?? {}).includes('Grace'));
      const ann = await studio.annotate({ t: 5.2, clips: [], note: 'Make this lower third appear on the RIGHT side of the frame instead of the left.', shapes: [{ kind: 'arrow', x1: 500, y1: 880, x2: 1500, y2: 880 }] });
      const wait = waitTurn();
      await studio.send({ harness, model, text: 'Fix my annotation.', annotationIds: [ann.id] });
      await wait;
      const reply = studio.chat.at(-1)!;
      const after = s.annotations.find((a) => a.id === ann.id)!;
      const html = grace ? readFileSync(join(s.root, grace.src), 'utf8') : '';
      assert(after.status === 'resolved', `annotation ${after.status}; reply: ${reply.text}`);
      return { reply: reply.text, tools: reply.tools, resolution: after.resolution, rightInPage: /"position":"right"/.test(html) };
    });
  }

  report();
  return checks.every((c) => c.ok);
}
