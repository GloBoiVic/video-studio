# Video Studio

An open-source, AI-native video editor for macOS. You direct; a local coding agent (Claude Code or Codex, through
the CLI you already have installed and signed in to) does the editing. You watch the timeline change live, draw on
frames to point at mistakes, undo any agent turn, and export 1080p or 4K MP4. It also works as a plain manual editor
with no agent.

Why it is built this way: [docs/adr/0001-foundation.md](docs/adr/0001-foundation.md).

## Run it

Needs macOS on Apple silicon, Node 22+, and `ffmpeg`/`ffprobe` on the PATH (`brew install ffmpeg`).

```bash
npm install
```

```bash
npm start
```

Projects go to `~/Documents/Video Studio/` by default (`VIDEO_STUDIO_PROJECTS` changes that). Your library and brand
live in the app's data folder (`~/Library/Application Support/Video Studio/library`, or `VIDEO_STUDIO_HOME`).

## Test it

```bash
npm test
```

Unit and server tests (vitest): the edit model, undo and checkpoints, the path and network guards, the agent tools.

```bash
npm run selftest
```

An end-to-end run inside the real Electron app. It drives the same MCP path a real agent uses, with the language model
scripted. It covers rough cut, stale-write refusal, template graphic, look, annotation, fix, checkpoint/undo/redo,
reusing a template in a second project, 1080p and 4K export with pixel checks, and raw media unchanged. The report goes
to `test-results/selftest.json`. Add `VIDEO_STUDIO_SELFTEST_AGENT=claude` (or `codex`) to also run two turns with your
real agent. Live tests use the cheapest model of each agent: Haiku for Claude, GPT-6-Luna for Codex. Set
`VIDEO_STUDIO_SELFTEST_MODEL` to override that.

## How it works

```
 Electron window (React UI)  ──HTTP + events, token──►  Studio (Node, in Electron main)
   preview iframe ◄─postMessage─┐                        ├─ ProjectStore: the single writer
                                │                        │    (validate → write → revision → undo step)
 preview origin (other port, no network)                 ├─ Library: templates + brand
   film.html played by OpenFilm's timeline              ├─ frame host: offscreen Chromium → ffmpeg
                                                         └─ agent turn: spawns `claude -p` / `codex exec`
 agent CLI ──stdio──► studio MCP server ──HTTP, turn token──► the same Studio tools
```

- **The project is a folder.**
  - `film.html` is the edit, in the [OpenFilm](https://github.com/openfilm/openfilm) format: tracks of clips, plain
    HTML/CSS.
  - `media/` holds the footage, copied in and read-only.
  - `graphics/` holds the animated pages.
  - `exports/` holds the rendered videos.
  - `.studio/` holds the editor's own state: history, checkpoints, annotations, chat, and `access.json`.
- **The agent can only change the film through the studio tools:** `get_project`, `apply_edits`, `look`,
  `add_template_graphic`, `write_graphic`, `read_graphic`, `save_template`, `get_annotations`, `resolve_annotation`,
  `undo`, `import_media`, `list_templates`.
  - Claude Code runs with only Read/Glob/Grep plus these tools. Codex runs with `--sandbox read-only`.
  - Every write carries the revision the agent last read. If you changed something in between, the write is refused
    and the agent re-reads.
- **Model picker.** It sits next to the agent menu in the chat and is remembered per agent. "CLI default" uses the CLI's
  own config. Claude offers Opus, Sonnet and Haiku. Codex offers the models from its own cache
  (`~/.codex/models_cache.json`; only model names are read). Some listed models may not be allowed on your plan. When
  the account refuses a model, the chat says so and asks you to pick another.
- **Undo.** Every edit is one undo step, labelled with who made it. Before each agent turn the app saves a
  checkpoint; **Undo this turn** in the chat restores it, and that restore can itself be undone.
- **Annotations.** Use Mark up (circle, arrow, box, pen) on the preview, then add a note. The agent receives the note's
  time, the clips on screen, the shapes, and a picture of the frame with your drawing on it.
- **Library.** Templates are OpenFilm pages that read `window.PARAMS`. Using one copies it into the project, so a
  project never depends on the library. The agent can turn any graphic into a template with `save_template`.

## Status of the first milestone

| Goal | Status |
| --- | --- |
| macOS desktop app | Runs from source (`npm start`). Not packaged or signed yet. |
| Preview, timeline, agent chat | Works: play, scrub, move/trim/split/delete, mute/lock tracks, live updates |
| Import into an isolated project | Works: copied, hashed, read-only, checked unchanged after a full session |
| Agent edits visible on the timeline | Verified with real Claude Code (rough cut, lower third, look) and Codex on GPT-6-Luna (volume change, look) |
| Annotation the agent acts on | Verified with real Claude Code: circled a lower third, asked to move and rename it, fixed and resolved |
| Reusable animated graphic | `lower-third` template plus brand colors. Saved as a user template and reused in a second project |
| Undo / checkpoints | Per-edit undo/redo; per-turn checkpoints; restore is undoable; history survives restart |
| Export | 1080p and 4K H.264/AAC verified by ffprobe and pixel checks (7–8 s film: about 14 s and 17–27 s) |

## Not proven yet

- **Long or heavy projects.** Only tested on films under 10 s with two clips. Speed for long 4K exports, many tracks or
  big pages is unknown. Export draws one frame at a time in one window.
- **Preview sound.** Synced by simple `<audio>` elements, with no fades during preview. Exports mix sound properly.
- **Packaging.** No `.app` bundle, code signing, auto-update or bundled ffmpeg yet. Electron has to be downloaded by
  `npm install`.
- **Codex depth.** Codex has only done one small edit; it hasn't fixed an annotation yet. Several models in Codex's
  own list are refused on a ChatGPT plan. The chat explains this and you pick another model.
- **Pausing an agent.** Stop ends the turn; you then redirect with a new message. A true pause/resume mid-turn isn't
  available.
- **Edits made outside the app.** Changing `film.html` in another app while Video Studio is open isn't picked up. The
  app is the only writer.
- **Access to outside folders.** Read roots in `.studio/access.json` limit what the agent may import. There is no
  settings screen for them yet.
- **Your YouTube workspace.** Not connected, and not touched. The plan is to add it as a read root plus project
  instructions in `.studio/instructions.md`.
