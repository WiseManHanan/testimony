# TESTIMONY
### A Minesweeper variant where the mines already exploded and the witnesses are lying

---

## 1. Core concept

Classic Minesweeper hides the mines and gives you honest numbers.

**Testimony inverts this.** You arrive *after* the explosion, as a claims adjuster for the Municipal Demolition Insurance Authority. Some mines are visible craters — confirmed. Some are still buried. Every surviving tile has filed a claim stating how many mines were adjacent to it.

Some of those tiles are committing insurance fraud.

You don't win by clearing the board. You win by **correctly identifying which tiles lied**, and issuing the right payouts.

The structural change: in Minesweeper the *mines* are unknown and the *clues* are trustworthy. Here, the clues are the unreliable half. That opens a different deduction space — you're reasoning about the reliability of information, not just its content.

---

## 2. Rules

### Given to the player at the start of each case
1. The board, with **confirmed craters** already visible.
2. `M` — the exact number of mines still buried (unconfirmed).
3. `L` — the exact number of tiles that filed a fraudulent claim.

### Claims
- Every non-crater tile files a claim: an integer 0–8.
- A claim states the number of mines adjacent to that tile (8-neighborhood, including diagonals).
- Adjacent mines = confirmed craters **plus** buried mines. The player can see craters, so craters are free information.
- **A tile sitting on a buried mine still files a claim.** It reports on its *neighbors*, not itself. This is important — it produces the best "aha" moments (see §3).
- Honest tiles report the true count. Fraudulent tiles report anything else.

### Winning
The player marks exactly `L` tiles as fraudulent and submits. Correct → case closed, payouts issued. Incorrect → the fraud goes unpunished, your performance review suffers.

Optionally the player also marks buried mine locations. Recommended for higher difficulties — it forces full solving rather than pattern-spotting the liars.

### Design intent of the two constraints
The two numbers do different jobs and together they form the entire difficulty curve:

- **`M` (mine budget)** creates *over-claim contradictions*. If a tile claims more mines than could possibly exist in its neighborhood given the remaining budget, it's provably lying. Cheap, satisfying catches. These are your tutorial hooks.
- **`L` (liar budget)** creates *trust propagation*. Once you've caught all `L` liars, everything else is guaranteed honest and the board collapses into ordinary deduction. Once you've caught `L-1`, you know exactly one lie remains hidden.

Low `L` = a logic puzzle. High `L` = a paranoia simulator.

---

## 3. Worked example (use this as the tutorial board)

3×3 grid. `A1` is a confirmed crater. `M = 1`, `L = 1`.

```
      col 1    col 2    col 3
row A [CRATER]  [ 2 ]   [ 1 ]
row B [  1  ]   [ 2 ]   [ 0 ]
row C [  2  ]   [ 1 ]   [ 1 ]
```

**Solution path:**

**Step 1 — catch the loud one.**
`C1` claims 2. Its neighbors are only `B1`, `B2`, `C2`. `A1` is *not* adjacent to `C1`, so the crater can't be part of that count. `C1` is asserting two mines in that pocket — but only one mine exists on the entire board. `C1` is lying. Proven, before examining anything else.

Since `L = 1`, every other tile is now guaranteed honest.

**Step 2 — locate the mine.**
`A3` claims 1. Its neighbors are `A2`, `B2`, `B3` (again, no `A1`). So the buried mine is one of those three.

`B3` claims 0. Its neighbors include `A2` and `B2`. Both are clean.

By elimination, the mine is under **`B3` itself** — the tile that just testified its neighborhood was spotless. Technically accurate. It was sitting on the bomb the whole time.

**Step 3 — verify.**
`B1` sees `A1` → 1 ✓ · `A2` sees `A1`+`B3` → 2 ✓ · `B2` sees both → 2 ✓ · `C2` sees `B3` → 1 ✓ · `C3` sees `B3` → 1 ✓
Only `C1` fails. Unique solution.

**Why this is the right tutorial:** the fraudster is loud and obvious, but the actual story is the quiet honest tile that was technically correct and completely useless. That tension is the game's whole personality — design later puzzles to reproduce it.

---

## 4. Puzzle generation & the uniqueness guarantee

This is the technically interesting part and the thing to build first. Do not ship without a uniqueness checker.

### 4.1 The key insight

Naively you'd think you must enumerate `(mine placement × liar set)` pairs — combinatorially brutal.

You don't. **The liar set is fully determined by the mine placement.**

Given a candidate mine placement `H`, compute the true adjacency count for every filing tile. Any tile whose claim disagrees with the truth *must* be a liar. So:

```
liar_set(H) = { tile : claim[tile] != true_count(tile, H) }
```

A mine placement `H` is a **valid solution** if and only if `|liar_set(H)| == L`.

So you only enumerate mine placements. For a 6×6 board with 4 buried mines that's C(36,4) = 58,905 candidates — trivial. Uniqueness = exactly one `H` yields `|liar_set(H)| == L`.

### 4.2 Generation algorithm

```
function generate(width, height, numCraters, M, L):
    loop up to N attempts:
        1. Randomly place numCraters craters and M buried mines (disjoint sets)
        2. Compute true claim for every non-crater tile
        3. Randomly select L filing tiles to be liars
        4. For each liar, perturb its claim to a different legal value (0-8).
           Bias toward +1 / +2 — over-claims produce cleaner contradictions
           and read as "greedy claimant", which is thematically correct.
        5. Run solve() — enumerate all mine placements, count valid ones
        6. If exactly 1 valid solution -> return puzzle
           Else -> discard and retry
    return null
```

### 4.3 Solver

```
function solve(board, M, L):
    solutions = []
    for each combination H of M cells from non-crater cells:
        violations = 0
        for each filing tile t:
            if claim[t] != countAdjacentMines(t, craters ∪ H):
                violations++
                if violations > L: break      // prune early
        if violations == L:
            solutions.append(H)
            if solutions.length > 1: return solutions   // early exit
    return solutions
```

**Scaling notes:**
- Under ~10⁶ combinations: brute force is fine, runs in milliseconds.
- Beyond that: switch to DFS over cells with constraint propagation. Prune a branch as soon as accumulated violations exceed `L`, or as soon as a fully-determined tile's claim is unsatisfiable.
- Precompute the neighbor list for every cell once. Represent mine sets as bitboards (`u64` for boards up to 8×8) — `countAdjacentMines` becomes `popcount(neighborMask[t] & mineBits)`. Fast enough to generate puzzles live.

### 4.4 Difficulty tiers

| Tier | Board | Craters | `M` | `L` | Character |
|---|---|---|---|---|---|
| Tutorial | 3×3 | 1 | 1 | 1 | Over-claim catch, single elimination |
| Junior adjuster | 5×5 | 2 | 2 | 1 | Trust propagation after first catch |
| Senior adjuster | 6×6 | 3 | 3 | 2 | Two liars — no full trust until both found |
| Fraud unit | 8×8 | 4 | 5 | 3 | Requires systematic case analysis |
| Internal affairs | 8×8 | 2 | 6 | 4 | Sparse craters, minimal free information |

Beyond mechanical difficulty, grade puzzles by **solution path**: does a human-style solver (over-claim contradiction → forced elimination → trust propagation) reach the answer without brute-force case-splitting? Implement a heuristic solver that applies only these human techniques and reject puzzles it can't crack. This is the difference between "hard" and "tedious".

---

## 5. Tech stack (non-Unity)

### Recommended: TypeScript + Web

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Strong typing for the solver; you'll want it |
| Build | Vite | Zero-config, instant HMR |
| Rendering | HTML/CSS grid + React, *or* raw Canvas 2D | The board is a grid of ~64 elements. DOM handles it fine and gives you free accessibility, transitions, and text layout. Canvas only if you want heavy particle effects |
| Audio | **Tone.js** | Critical — see §6 |
| Solver | Plain TS in a Web Worker | Keeps generation off the main thread |
| Persistence | LocalStorage or IndexedDB | Case progress, unlocks, stats |
| Distribution | Static host (Netlify/Vercel/itch.io) | Instant sharing, no install friction |

The whole game is a pure function of board state. No physics, no 3D, no asset pipeline. Unity would be pure overhead here.

### Alternative: Godot 4 + C#

Leverages your existing C# knowledge. Better if you want to ship native desktop/mobile builds without wrapping. `Control` nodes and `GridContainer` handle the board; `AudioStreamPlayer` handles music, though procedural audio is much more work than Tone.js.

**My recommendation:** web. The audio concept in §6 is the game's second-biggest joke and Tone.js makes it nearly free.

---

## 6. Audio design — the second joke

**Implemented.** See `src/audio/soundtrack.ts`.

### The direction

A bossa nova loop rendered as if through a 1995 sound card.

An earlier version of this section called for tastefully bland lounge muzak.
That was wrong, and it is worth recording why: **bland executed well is just
bland.** The gag lands once, in the first ten seconds, and then the player is
listening to boring music for an hour. It was a joke that worked in a design
document and failed in the ears.

The fix came from the art direction. The game now looks like a 1995 desktop
utility, so it should sound like one — which does not mean tasteful jazz, it
means **MIDI**. Cheap FM synthesis. A plastic electric piano, a rubbery bass, a
muted trumpet that sounds like a kazoo. That is genuinely enjoyable to listen
to *and* unmistakably fake. Characterful, not merely inoffensive.

### Signal chain

```
FM voices -> bitcrusher (8-bit) -> highpass 320Hz -> lowpass 3.6kHz
          -> short dull reverb -> out
```

The bitcrusher is the single most important effect. Without it the FM voices
read as a competent modern synth rather than a sound card.

The bandpass is a small plastic speaker. Diegetically this is a radio in the
claims office, which licenses the lo-fi and makes cutting to silence available
as a deliberate tool.

### Structure

Eight bars of ii-V-I in C at 104 BPM with a secondary dominant turnaround.
Endlessly pleasant, going nowhere. Bossa comping on beats 1, the "and of 2",
and 4 — the syncopation is what stops it being a nursery rhyme.

Four independently gated layers: `chords`, `bass`, `drums`, `vibes`. Fade them
with `setLayer()` rather than starting and stopping parts.

### THE RULE THAT MUST SURVIVE

**The music never acknowledges failure.** On a rejected determination it keeps
playing, cheerfully, exactly as before. Every instinct will push toward a sad
trombone or a key change. Resist it — indifference is funnier than menace, and
indifference from a cheap MIDI loop is funnier still.

`duck()` exists for moments that need air. It is used on a *correct*
determination only. Never wire it to failure.

### SFX

Bureaucratic, not explosive. All synthesised, never sampled — Windows 95 WAVs
are Microsoft's assets, same rule as the sprites (ART.md).

- `stamp` — wooden knock on every mark. Not a beep.
- `correct` — two-tone rising bell. A form being accepted.
- `invalid` — flat two-note thud. A dialog you cannot dismiss.
- `reveal` — distant muffled boom. It happened in another building and nobody
  in this one looked up.

### Still open

- Idle behaviour: after ~45s without input, fade in the `vibes` layer. The
  game is waiting patiently and wants you to know.
- Win streak unlock: sleigh bells over identical chords.
- Long losing streak: detune the electric piano a few cents per case. Never
  enough to notice in one session. Add a settings toggle reading
  "Tuning: Standard / Standard".

## 7. Presentation & tone

- **Visual language:** Manila folders, carbon-copy forms, rubber stamps, faded municipal letterhead. Muted beige/olive palette. Monospace or typewriter type for claim values.
- **Framing:** Each puzzle is a numbered case file. Claims are literal forms with a claimant name and a stated figure.
- **Voice:** Deadpan bureaucratic. Never wink at the player. The humor comes from total procedural sincerity about an absurd premise.
- **Post-case report:** Name the fraudster, state the payout, and — critically — mention the honest tiles that gave technically true but useless testimony. `"B3 stated its neighborhood was clear. This was accurate. B3 was located on the remaining ordnance. No action taken."`

---

## 8. Build order

1. **Board model + claim computation.** Pure data, no UI. Unit test adjacency thoroughly, especially edges and corners.
2. **Solver.** Brute force first. Test against the 3×3 example in §3 — it must return exactly one solution.
3. **Generator with uniqueness rejection.** Now you can produce infinite valid puzzles. This is your foundation.
4. **Minimal UI.** Grid, claim display, mark-as-fraud toggle, submit. Ugly is fine.
5. **Play 20 generated puzzles yourself.** Tune `M`/`L` ratios. Find out which feel elegant and which feel like brute-force homework.
6. **Human-technique solver** for difficulty grading. Reject puzzles requiring exhaustive case analysis.
7. **Audio layer.** Tone.js base loop, then adaptive triggers.
8. **Visual polish and case-file framing.**
9. **Progression:** case numbers, adjuster rank, stats.

Steps 1–3 are the actual game. Everything after is presentation. Don't build the UI first.

---

## 9. Open design questions

- **Should the player mark mine positions, or only liars?** Liars-only is faster and more focused. Mines-too forces complete solving. Consider: liars-only at low tiers, both at high tiers.
- **Partial credit?** Catching 2 of 3 liars — pass with a reduced payout, or fail? Partial credit is kinder but weakens the "prove it" rigor that makes the game sharp.
- **Should craters ever be *fake*?** A crater that isn't really a mine would add a second layer of unreliability. Probably too much — the player needs *some* ground truth to reason from. Consider as an endgame twist mechanic only.
- **Multiplayer:** Two adjusters race the same case file. The first correct submission wins; a wrong submission locks you out for 30 seconds. Cheap to add, high replay value.

---

## 10. Prior art note

Minesweeper is 40 years old and heavily mined for variants (hex grids, 3D, adversarial/"evil" placement, roguelike, multiplayer). I can't verify that no one has built this specific inversion. What's uncommon here is inverting *which half of the puzzle is hidden* — treating the clues as the unknown and the mines as the given. Worth a search for "unreliable clue Minesweeper" and "liar puzzle Minesweeper" before you commit to a name, but the bureaucratic-fraud framing and the adaptive hold-music are yours regardless.
