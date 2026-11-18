# ADR 0002: Pause development and adopt OpenFilm

Status: accepted, 2026-11-17

## Decision

Development of Video Studio is **paused**. OpenFilm (the desktop app, v0.3.2) is being trialled as the primary
editor for the YouTube workflow instead. The code here is kept as it is, working and tested. Nothing is being deleted
or archived. The roadmap after milestone 1 is not being pursued.

## Why

- **The goal is making videos, not building an editor.** OpenFilm already ships a polished editing environment,
  templates, effects, transitions, agent chat inside the app, and 4K export. Video Studio would take a long time to
  match it.
- **Video Studio already builds on OpenFilm.** It uses OpenFilm's `film.html` format and its player, so the two share a
  foundation. Most of our work was the shell around it, which OpenFilm's own app provides.
- **Tandem was tried and dropped.** It is a capable design, but more limited for this workflow.

## What stays useful if we come back

- Milestone 1 works and is verified: agent edits over MCP with revision checks, per-turn checkpoints, drawn
  annotations, a template library, and 1080p/4K export through Electron's Chromium. The README's "Status" and "Not
  proven yet" sections describe it exactly.
- The ideas most worth carrying into OpenFilm, as configuration or small extensions, are revision-checked agent
  writes, a drawn-annotation image sent to the agent, and cheap-model defaults for agent tests.

## When to revisit

Only if the OpenFilm trial shows a gap that configuration, templates, skills or a small extension can't close. Even
then, try an extension to OpenFilm first.
