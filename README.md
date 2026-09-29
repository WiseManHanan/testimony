# Testimony

A Minesweeper variant where the mines already exploded and the witnesses are lying.

## Quick start

```bash
npm install
npm test        # 38 core tests, no build step
npm run dev     # playable UI at localhost:5173
```

## Docs

- `DESIGN.md` — full game design: rules, generation algorithm, audio, build order
- `ART.md` — visual direction (classic Minesweeper chrome)
- `CLAUDE.md` — working context for Claude Code

## Layout

```
src/core/       tested game logic — board, solver, generator
src/main.ts     rough playable UI (placeholder, do not polish yet)
```

## Status

Core logic complete and tested. Next task is tuning the M/L difficulty ratios by
actually playing generated cases — see CLAUDE.md.
