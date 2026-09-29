# CLAUDE.md — Testimony

Context for working on this repo. Read `DESIGN.md` for the full game design and
`ART.md` for the visual direction.

## What this is

A Minesweeper variant that inverts which half of the puzzle is hidden. The mines
are partly given (visible craters); the *clues* are unreliable. The player is an
insurance claims adjuster identifying which tiles filed fraudulent claims.

## Current state

`src/core/` is **done and tested**. `npm test` runs 38 core + 92 grader tests
(plus 43 for the annotation layer); typecheck is clean.

- `types.ts` — board and puzzle types
- `board.ts` — geometry, adjacency, claim computation, cell labels
- `solver.ts` — DFS solver with pruning, plus a brute-force oracle for tests
- `generator.ts` — generate-and-reject with a uniqueness guarantee; optional
  `requireHumanSolvable` runs the grader as an extra filter, and an optional
  `telemetry` arg tallies rejection causes
- `grader.ts` — the human-technique solver (step 6). Grades a puzzle by
  solving it with only over/under-claim contradiction, forced elimination and
  trust propagation — no case-splitting — and reports `solvable`, a
  provisional `difficulty` band and a step-by-step trace. Never touches the
  hidden `Solution`; it is a generation-time grader, **not** an in-game hint
- `core.test.ts`, `grader.test.ts` — run with `npm test`

`src/tools/tune.ts` is the M/L tuning harness (step 5): `npm run tune -- <play
| sweep | sample>`. `sweep` reports `human%` (grader pass rate) per tier and
its M±1/L±1 neighbours. First finding: **the liar budget is the constraint** —
L=1 configs grade ~75–92% human-solvable, L=2 ~17–50%, L≥3 ≈ 0%. The current
`senior`/`fraudUnit`/`internalAffairs` M/L values need retuning.

`src/game/annotations.ts` is **done and tested** — the player's marking layer.

- Verdict and ordnance as independent axes
- Undo/redo via `NoteHistory`
- `review()` — bookkeeping aid that checks marks against claims
- Bulk helpers: `autoClearRemaining`, `approveRemaining`, `clearAll`
- `clearAll()` — wipe the board, routed through history so it stays undoable
- `annotations.test.ts` — 43 tests

`src/main.ts` + `src/style.css` implement the classic Minesweeper art direction
described in `ART.md`. The styling is now real, not placeholder. The one thing
to understand before touching it: the cell bevel means "has the PLAYER settled
this", not "has the game revealed this" — see ART.md for why. The game requests
grader-vetted puzzles for `junior`/`senior` only (`HUMAN_SOLVABLE_TIERS`);
`fraudUnit`/`internalAffairs` can't reliably produce a human-solvable board at
their current M/L, so they stay un-vetted until step 5 retunes them.

`src/audio/soundtrack.ts` is built (step 7). No case-file presentation, no
progression yet.

## The annotation model

**Two independent axes. Never collapse them into one mark cycle.**
The tutorial board is the proof: `B3` is a mine *and* honest; `C1` is clean
*and* a liar. One axis cannot express that.

```
verdict:  'none' | 'approved' | 'questionable' | 'fraud'   (left-click)
ordnance: 'none' | 'clear'    | 'mine'         | 'maybe'   (right-click)
             ⊘ no mine        ● mine           ◌ possible
```

**`clear` is first in the ordnance cycle on purpose.** Most cells on any board
are safe — a senior 6x6 has 3 mines and 33 other cells — so ruling a cell out
is the commonest action and must cost one click. Minesweeper puts the flag
first because there you never mark safety explicitly; here you do, constantly.
Do not "restore" Minesweeper ordering.

`clear` and `mine` are certainties; `maybe` is a candidate that counts as
**open** in `review()`. That distinction has teeth and is tested: ruling out
seven cells with `clear` forces the mine into the eighth, while marking the
same seven `maybe` forces nothing.

Certain states get a solid 7px edge bar; `maybe` gets a broken one. Cells ruled
out also recede — muted claim number, cool tint — so the eye stops returning to
settled ground.

Each cycles forward on click and wraps. The active left-click tool is
switchable so the game is playable on touch without a right button.

Visually: **the verdict is the loud element** — a large glyph filling the cell
plus a full background tint. The filed claim number sits small in the corner.
Ordnance is a corner glyph plus a coloured left edge bar, so the two axes never
compete for the same pixels. Verdict uses warm hues (green / amber / red,
tracking suspicion); ordnance uses cool hues (purple / blue). Show-working
overlays are diagonal hatching, never a flat fill, so they can't be mistaken
for a mark.

`questionable` replaced an earlier pencil/tentative modifier. An explicit
visible state beat an invisible flag — if you are tempted to reintroduce a
tentative modifier, make it another verdict state instead.

`maybe` ordnance counts as **open** in `review()`, not as a mine. Pencilling a
guess widens the possibility space rather than asserting anything.

Every bulk action — including **Clear board** — goes through `NoteHistory.apply`,
so a mis-click is always recoverable with undo. Keep it that way for any bulk
helper added later.

### Considered and rejected: auto-clearing from 0 claims

Minesweeper flood-fills from a 0 because a 0 is trustworthy. **Here it is not.**
A tile claiming 0 can be the liar — the tutorial board's `B3` claims 0 while
sitting on the mine. Auto-clearing its neighbours makes the game assert
something false and deletes the puzzle's best moment.

A version was built and reverted. If it is ever revisited, it must be an
explicit *assumption* layer: derived per-render rather than written into
`notes`, rendered in a neutral colour that cannot be mistaken for a player
mark, never clearing the 0-claimant itself, and withdrawn the moment the player
marks that claimant `fraud` or `questionable`.

### How much help is too much

`review()` compares the player's own marks against the visible claims and
reports `over` (more mines marked than a claim allows) and `under` (not enough
open cells remain to reach a claim). It also flags `disputesOwnApproval` — a
claim the player approved *and* made unsatisfiable, i.e. they contradicted
themselves. **It never consults the hidden solution.**

This is deliberately the ceiling. Do not add a hint system that runs the real
solver against the hidden answer — the game's whole appeal is that every
accusation must be *provable*, and a solver-backed hint destroys that.

Useful property, verified in tests: under the correct mine placement, the only
conflicting claim on the tutorial board is `C1` — the actual liar. So "show
working" converges on the fraudster once the player's ordnance marks are right.
It confirms reasoning rather than replacing it.

## Rules that are easy to get wrong

1. **A cell sitting on a buried mine still files a claim.** It reports on its
   neighbours, not itself. This is deliberate — it produces the best moments
   (see the tutorial board, where `B3` truthfully reports a clean neighbourhood
   while sitting on the mine).
2. **Craters file no claims.** Their `claims[]` entry is `CRATER` (`-1`).
3. **Craters count toward adjacency** for everyone else. They are free
   information for the player.
4. Adjacency is the full 8-neighbourhood, diagonals included.

## Verified tutorial board

3×3, crater at `A1`, `M=1`, `L=1`:

```
[X] [2] [1]
[1] [2] [0]
[2] [1] [1]
```

Unique solution: mine at `B3`, liar at `C1`. Asserted in the test suite. If a
refactor breaks this, the refactor is wrong.

## Build order (from DESIGN.md §8)

Steps 1–4, 6 and 7 are done. Remaining:

4. ~~Minimal UI + annotation tools~~ — done; styling is real (ART.md)
5. **Play 20 generated puzzles and tune M/L ratios.** Still the open task, now
   with tools: `npm run tune -- play` logs rated sessions, `-- sweep` reports
   `human%` per tier. The grader (step 6) already shows L is the constraint —
   `senior`/`fraudUnit`/`internalAffairs` M/L in `generator.ts TIERS` need
   retuning, or step 6's technique set needs widening (subset elimination,
   depth-1 hypotheticals), or the top tiers must accept some case-splitting.
6. ~~Human-technique solver for difficulty grading~~ — `src/core/grader.ts`.
   `grade(puzzle)` → `solvable` + provisional `difficulty` + step trace, using
   only over/under-claim contradiction, forced elimination and trust
   propagation. Wired into `generate()` via `requireHumanSolvable`. The
   difficulty bands are a first pass; calibrate them during step 5. Do **not**
   widen it into a solver-backed in-game hint — see "How much help is too much".
7. ~~Audio~~ — `src/audio/soundtrack.ts` is built. FM bossa loop through a
   bitcrusher and a small-speaker bandpass. **The music must never react to
   failure** — see DESIGN.md §6 before touching it.
8. Visual polish. **See ART.md — the direction is classic Minesweeper chrome,
   which supersedes DESIGN.md §7's manila-folder concept.**
9. Progression: case numbers, adjuster rank, stats.

## Audio, briefly

Corporate hold music. Bossa nova / smooth jazz muzak, 95–110 BPM, short loop.
Built as independently gated Tone.js layers, not one audio file.

**The critical rule: the music never acknowledges failure.** It keeps playing,
cheerfully, over the failure screen. Every instinct will push toward a sad
trombone. Resist it — indifference is the joke.

## Performance notes

Generation timings from the test suite (single case, seeded RNG):

- tutorial / junior / senior: under 1ms
- fraudUnit (8×8, 5 mines): ~3ms
- internalAffairs (8×8, 6 mines): ~20ms

40 senior cases generate in ~15ms total. Fast enough to generate on the main
thread today. If tiers grow past 8×8 or 7+ mines, move generation into a Web
Worker before it starts blocking input.

Generation is generate-and-reject, so rejection rate — not solve speed — is the
real cost driver. Tight `M`/`L` ratios reject more. `maxAttempts` defaults to
2000; `generate()` returns `null` if it gives up. **Always handle the null.**

## Conventions

- Imports use explicit `.ts` extensions (works with both Vite and
  `node --experimental-strip-types`, so tests need no build step).
- `npm test` runs the suite directly through Node — no test framework. Keep it
  that way unless there is a real reason; the zero-dependency test loop is fast.
- `npm run typecheck` must stay clean.

## Open design questions

- Mark liars only, or mines too? Currently liars only. Mines-too forces complete
  solving; consider gating by tier.
- Partial credit for catching 2 of 3 liars?
- Should craters ever be fake? Probably too much — the player needs some ground
  truth. Endgame twist at most.
- Multiplayer: two adjusters race the same case, wrong submission locks you out
  30 seconds.

## Prior art caveat

Minesweeper has 40 years of variants. The inversion here (clues unknown, mines
given) seems uncommon but is unverified. Worth searching "unreliable clue
Minesweeper" and "liar puzzle Minesweeper" before committing to a public name.
