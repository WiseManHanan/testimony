# ART.md — Testimony

Art direction. Read alongside `CLAUDE.md`.

## The direction

Classic Minesweeper. Windows 95/98 chrome: `#C0C0C0` face, 2px hard bevels, the
teal desktop, seven-segment LED counters, a chunky face button, no
anti-aliasing, no rounded corners, no shadows, no gradients except the title bar.

**Why this and not something original.** Testimony is an *inversion* of
Minesweeper. Wearing the original's exact skin makes the subversion land — the
player recognises everything, reaches for familiar habits, and the habits are
wrong. A bespoke art style would announce "this is a different game" and throw
that away. The comedy is in the deadpan familiarity.

An earlier two-colour risograph direction was pitched and rejected in favour of
this. Do not drift back toward bespoke styling.

## The one real adaptation

Classic Minesweeper's bevel answers: **has the game revealed this cell?**
Testimony shows every claim from turn one, so that question has no meaning here
— every cell would be sunken and the visual language would be dead.

So the bevel is repurposed to answer: **has the player settled this cell?**

```
raised          undecided, still in play
sunken          ruled out — no mine here, certain
raised + flag   you assert a mine
raised + "?"    candidate, not committed
```

This is the single most recognisable feature of the original mapped onto the
new mechanic without inventing anything foreign. It also means the commonest
action — ruling a cell out — produces the most satisfying feedback, the click
into sunken. Do not "fix" this back to game-reveal semantics.

## Cell anatomy

Three pieces of information share one cell. They must not fight:

- **Claim number** — centred, bold, in the canonical Minesweeper palette
  (1 blue, 2 green, 3 red, 4 navy, 5 maroon, 6 teal, 7 black, 8 grey). Keep
  those hexes exact; they are the most recognisable thing on screen.
- **Ordnance** — overlays and dims the number, exactly as a flag does in the
  original. Asserting a mine means you have stopped reading the testimony and
  started reading the ground.
- **Verdict** — a small coloured corner tab, top-right. Deliberately *not* a
  background fill: the cell face must stay grey or it stops reading as
  Minesweeper. Verdict has no equivalent in the original, so it gets the one
  piece of non-canonical vocabulary.

Cells are 38px (`--cell`), not the original's 16px — three channels do not fit
in sixteen pixels.

**Cells must sit flush, with no gap.** The board is an `inline-grid` with fixed
`var(--cell)` track sizes. Do not use `1fr` tracks: they stretch the columns to
the frame width and scatter the cells across it. For the same reason the play
frame stays a plain block — making it a stretching flexbox re-breaks the board.

## The status bar

The two LED counters map cleanly:

- **Left** — in Minesweeper, mines remaining. Here, fraudulent claims still to
  be named. Same meaning: what you still owe the board.
- **Right** — ordnance still unaccounted for.
- **Face button** — new case. Redrawn as a rubber stamp, which is the closest
  thing a claims adjuster has to a smile. Shows a tick or cross after
  submission.

No timer. Testimony is not a speed game; adding one would push players toward
guessing, which the whole design is built to punish.

## Intellectual property

**There are no Microsoft assets in this project and there must not be.** The
Win95 chrome *style* is widely reimplemented (98.css and similar) and is fine
to build. The specific mine, flag and smiley sprites are Microsoft's artwork.
Everything here is drawn with CSS borders and Unicode glyphs.

If bitmap art is added later, it must be drawn from scratch. Do not import
sprite sheets ripped from `winmine.exe`, and do not ship the name "Minesweeper"
in the product.

Fonts: "MS Sans Serif" is referenced first but will only resolve on machines
that happen to have it. The fallback chain handles everyone else. If exact
period type matters, look at a licensed or open pixel font rather than
redistributing Microsoft's.

## What not to do

- No rounded corners, no `box-shadow`, no gradients outside the title bar.
- No anti-aliased icon fonts or SVG icon sets — the aesthetic is aliased.
- No animation beyond instant state flips. The original has none.
- No dark mode. Windows 95 did not have one.
- Do not tint the cell face for verdict states. Corner tabs only.

## Still open

- A proper redrawn mine and flag glyph as inline SVG, replacing the Unicode
  stand-ins. Unicode `\u2691` renders inconsistently across platforms.
- Win95 dialog boxes for the case result, instead of inline text.
- A "Marks" menu that actually opens, for the bulk actions.
- Sound: the original had almost none, which suits the deadpan tone. See
  DESIGN.md §6 — the hold-music concept still stands and is unaffected by this
  art direction.
