# ADR 0001: Foundation

Status: accepted, 2026-11-17

## Decision

Video Studio is its own Electron + TypeScript app. It uses the **OpenFilm Protocol** (`film.html`) as its project format
and the published **`openfilm` npm package** (MIT, unmodified) as its format library and preview player. On top of that
it adds its own parts:

- **A single-writer command layer.** This idea comes from Tandem. Every change goes through one queue: the person's
  timeline edits, the agent's tools, undo, and restores. Each change is validated, written atomically, given a new
  revision, and kept as one undo step with its author.
- **An agent bridge with no tie to one provider.** Claude Code and Codex run as the person's own installed CLIs. They
  edit only through a small MCP tool server that calls back into the app.
- **Its own export host.** Frames are captured from an offscreen Electron window, then encoded with ffmpeg.
- **Visual annotations, checkpoints, and a template/brand library.**

## What was inspected (Nov 2026)

| Repo | What it is | License | Verdict |
| --- | --- | --- | --- |
| openfilm/openfilm v0.3.2 | Agent-first video editor: HTML film format, Studio UI, Electron desktop, ACP agents, Chromium+ffmpeg render, 4K | MIT (name is trademarked) | **Use the format and package; don't fork** |
| mikecann/tandem | Native Swift editor with CLI/MCP/SDK: command batches, revisions, flock, journal, review diff | MIT | **Borrow its design** (Swift, personal tool) |
| AnayDhawan/openvidstudio | Remotion pipeline, about 44 MCP tools: plan, approve, capture, render, validate | Apache-2.0, but Remotion | Borrow its pipeline ideas |
| NDilanka/openvids | A Claude Code skill: storyboard, then subagents, then Remotion render | MIT, but Remotion | Borrow its review ideas |

"OpenVids" has no single canonical repo. NDilanka/openvids matches the name best. openvidstudio is the bigger
pipeline.

## Why

- **Format.** OpenFilm's `film.html` is plain HTML. Agents already write HTML and CSS well. A graphic is a page with a
  deterministic `frame(t)`, so any web animation can be a reusable template. The spec is short, and the package's
  parser and player are tested.
- **Forking OpenFilm was rejected.** It is about 134k lines at v0.3 with one squashed commit. A published fork must
  drop the "OpenFilm" name. It also has service/account hooks and a Pi-SDK built-in agent we don't want. Depending on
  the package lets us take upstream fixes through `npm update` while keeping our UI simple.
- **Write safety comes from Tandem's model, not OpenFilm's.** In OpenFilm, the agent edits the file directly and the
  app merges afterwards. Here, the agent has no file-write tools at all. Each write carries `expectedRevision`, and a
  stale write is refused with a clear message. Conflicting timeline writes can't happen.
- **The OpenVids repos were rejected as foundations.** Both are Remotion pipelines with no timeline or human editing.
  Remotion also needs a paid company license above 3 employees. Their useful ideas are planned for the agent's
  instructions later: plan → approve → build → contact-sheet review → validate.
- **Tandem was rejected as a foundation** because it is native Swift and tuned to one author's workflow.

## Rendering

- OpenFilm's own export uses Playwright with a downloaded headless Chromium.
- We render with **Electron's built-in Chromium** instead, using OpenFilm's protocol hooks (`HOST_FLAG`,
  `filmHost.time`/`settle`) and its audio mix helper. This means no second browser download. Electron's Chromium also
  plays H.264.
- 4K is an offscreen window with zoom factor 2: a 1920×1080 layout drawn at 3840×2160.
- Encoding uses the system `ffmpeg`. Bundling an ffmpeg (GPL/LGPL build choice) is a later packaging decision.

## Security model

- Project media is copied in, hashed, and made read-only (`chmod 444`). Nothing ever writes it again.
- Preview and export pages are served from a **separate origin** on 127.0.0.1, with a CSP that blocks all network
  access. Untrusted pages can't reach the app's API or the internet. The app API requires a per-launch token and
  checks the Host header.
- The agent's CLI runs inside the project folder:
  - Claude Code: only its read/search tools plus the `studio` MCP tools.
  - Codex: `--sandbox read-only`.
- Importing from outside the project is limited to read roots that the person lists in `.studio/access.json`.
- We never read or copy credentials. Each CLI uses its own login.

## Consequences

- Upstream OpenFilm format changes may need adapter work. We pin the version and upgrade on purpose.
- Export speed is bound by the browser (roughly 15–20 ms per frame to capture at 4K, plus page draw time). That's
  fine for drafts. Very long films may need parallel windows later.
- Electron can't run inside Claude Code's command sandbox, so GUI tests run through the app launcher (see README).
