/**
 * Human-technique grader — DESIGN.md §8 step 6, §4.4.
 *
 * A puzzle can be *uniquely solvable* (solver.ts proves that) and still be
 * miserable to solve by hand, because the only route is exhaustive case
 * analysis. This grader is the filter for that: it solves the puzzle using
 * ONLY the moves a person actually makes, and reports whether that was enough.
 *
 * The techniques, in the order DESIGN.md §2 / §4.4 lays them out:
 *
 *   over/under-claim contradiction
 *       A claim that falls outside the range of mine counts still achievable
 *       around that cell — given the mine budget and what is already known —
 *       is provably fraudulent. No assumption of honesty required.
 *
 *   forced elimination
 *       On a cell now *known* to be honest: if its claim is already satisfied,
 *       the rest of its neighbourhood is clear; if its claim needs every
 *       remaining neighbour, they are all mines. Plus the two budget versions
 *       (all M mines placed → everything else clear; only enough room left for
 *       the outstanding mines → it is all mines).
 *
 *   trust propagation
 *       Once all L fraudulent claims are pinned, every other claim is honest
 *       and forced elimination opens up everywhere. The mirror also counts:
 *       if the unproven claims left are exactly as many as the liars still
 *       missing, they are all liars.
 *
 * NOT included, on purpose: hypothesis testing ("suppose this one lied…"),
 * subset/pair elimination, anything that branches. Those are where "hard"
 * becomes "tedious", and rejecting the puzzle is the right call.
 *
 * IMPORTANT: this never looks at the hidden Solution. It works purely from the
 * visible claims, the crater positions, M and L — the same information the
 * player has. It is a generation-time grader, not an in-game hint engine
 * (CLAUDE.md: no solver-backed hints).
 *
 * Soundness: every technique only concludes a fact that holds in *every*
 * completion consistent with the givens, so on a valid puzzle the liars it
 * names are always a subset of the real liars — see grader.test.ts, which
 * checks the grader's answer against the planted solution.
 */

import { getGeometry } from './board.ts';
import type { Puzzle } from './types.ts';

export type Technique =
  | 'over-claim'
  | 'under-claim'
  | 'forced-clear'
  | 'forced-mine'
  | 'mine-budget-clear'
  | 'trust-propagation'
  | 'liar-count-fill'
  | 'mine-count-fill';

/**
 * Rough "peak move" ordering — later entries are the more demanding
 * inferences. `hardestTechnique` is whichever step sits furthest down here.
 * The bands below are a first pass; tune them against real play data.
 */
const TECHNIQUE_ORDER: Technique[] = [
  'trust-propagation',
  'mine-budget-clear',
  'over-claim',
  'under-claim',
  'forced-clear',
  'forced-mine',
  'liar-count-fill',
  'mine-count-fill',
];

/** Counting-argument techniques — their presence bumps a puzzle to "hard". */
const COUNTING: ReadonlySet<Technique> = new Set<Technique>(['liar-count-fill', 'mine-count-fill']);

export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard';

export interface GradeStep {
  technique: Technique;
  /** The claim the deduction reasons *from* (or the first cell it acts on). */
  cell: number;
  detail: string;
  liars?: number[];
  honest?: number[];
  mines?: number[];
  clears?: number[];
}

export interface Grade {
  /** All L fraudulent claims identified using only the human techniques. */
  solvable: boolean;
  /** null when !solvable. Bands are provisional — see TECHNIQUE_ORDER. */
  difficulty: Difficulty | null;
  hardestTechnique: Technique | null;
  steps: GradeStep[];
  /** Fraudulent claims found, sorted. Equals the real liar set when solvable. */
  liarsFound: number[];
  /** Buried mines located, sorted. May be partial even when solvable. */
  minesFound: number[];
  /** True when every buried mine was also placed, not just the liars named. */
  minesComplete: boolean;
  /** When !solvable: what it got stuck on. null when solvable. */
  reason: string | null;
}

const UNKNOWN = 0;
const MINE = 1;
const CLEAR = 2;

const V_UNKNOWN = 0;
const HONEST = 1;
const LIAR = 2;

export function grade(puzzle: Puzzle): Grade {
  const g = getGeometry(puzzle.width, puzzle.height);
  const { claims } = puzzle;
  const M = puzzle.mineCount;
  const L = puzzle.liarCount;

  const isCrater = new Uint8Array(g.size);
  const mine = new Int8Array(g.size);
  for (const c of puzzle.craters) {
    isCrater[c] = 1;
    mine[c] = MINE;
  }

  const verdict = new Int8Array(g.size);
  const filers: number[] = [];
  for (let i = 0; i < g.size; i++) if (!isCrater[i]) filers.push(i);

  let minesFound = 0; // buried only, craters excluded
  const steps: GradeStep[] = [];
  let reason: string | null = null;

  const scan = (c: number): { known: number; unknown: number[] } => {
    let known = 0;
    const unknown: number[] = [];
    for (const n of g.neighbours[c]) {
      if (mine[n] === MINE) known++;
      else if (mine[n] === UNKNOWN) unknown.push(n);
    }
    return { known, unknown };
  };

  const setMine = (c: number): void => {
    if (mine[c] === CLEAR) {
      reason = `contradiction: a mine is forced onto ${c}, already proven clear`;
      return;
    }
    if (mine[c] === UNKNOWN) {
      mine[c] = MINE;
      if (!isCrater[c]) minesFound++;
    }
  };
  const setClear = (c: number): void => {
    if (mine[c] === MINE) {
      reason = `contradiction: cell ${c} is forced clear but already proven a mine`;
      return;
    }
    if (mine[c] === UNKNOWN) mine[c] = CLEAR;
  };

  const unknownVerdicts = (): number[] => filers.filter((c) => verdict[c] === V_UNKNOWN);
  const liarCount = (): number => filers.reduce((n, c) => n + (verdict[c] === LIAR ? 1 : 0), 0);

  let progress = true;
  loop: while (progress && reason === null) {
    progress = false;

    // ---- trust propagation: all L liars pinned → every other claim is honest
    if (liarCount() === L) {
      const rest = unknownVerdicts();
      if (rest.length > 0) {
        for (const c of rest) verdict[c] = HONEST;
        steps.push({
          technique: 'trust-propagation',
          cell: rest[0],
          detail: `all ${L} fraudulent claim(s) identified; the remaining ${rest.length} claim(s) are guaranteed honest`,
          honest: rest.slice(),
        });
        progress = true;
        continue;
      }
    }

    // ---- liar-count fill: the unproven claims left are exactly the liars still missing
    {
      const rest = unknownVerdicts();
      const missing = L - liarCount();
      if (rest.length > 0 && rest.length === missing) {
        for (const c of rest) verdict[c] = LIAR;
        steps.push({
          technique: 'liar-count-fill',
          cell: rest[0],
          detail: `${missing} liar(s) unaccounted for and exactly ${rest.length} claim(s) left unproven — all must be fraudulent`,
          liars: rest.slice(),
        });
        progress = true;
        continue;
      }
    }

    // ---- over / under-claim contradiction
    for (const c of filers) {
      if (verdict[c] !== V_UNKNOWN) continue;
      const { known, unknown } = scan(c);
      const budget = M - minesFound;
      const hi = known + Math.min(unknown.length, Math.max(0, budget));
      if (claims[c] > hi) {
        verdict[c] = LIAR;
        steps.push({
          technique: 'over-claim',
          cell: c,
          detail: `claims ${claims[c]} mine(s) adjacent, but at most ${hi} can be (${known} certain + ${hi - known} still possible)`,
          liars: [c],
        });
        progress = true;
        continue loop;
      }
      if (claims[c] < known) {
        verdict[c] = LIAR;
        steps.push({
          technique: 'under-claim',
          cell: c,
          detail: `claims only ${claims[c]}, but ${known} adjacent mine(s)/crater(s) are already certain`,
          liars: [c],
        });
        progress = true;
        continue loop;
      }
    }

    // ---- forced elimination on cells now known honest
    for (const c of filers) {
      if (verdict[c] !== HONEST) continue;
      const { known, unknown } = scan(c);
      if (unknown.length === 0) continue;
      if (known === claims[c]) {
        for (const n of unknown) setClear(n);
        steps.push({
          technique: 'forced-clear',
          cell: c,
          detail: `honest claim of ${claims[c]} already satisfied; its ${unknown.length} other neighbour(s) hold no mine`,
          clears: unknown.slice(),
        });
        progress = true;
        continue loop;
      }
      if (known + unknown.length === claims[c]) {
        for (const n of unknown) setMine(n);
        steps.push({
          technique: 'forced-mine',
          cell: c,
          detail: `honest claim of ${claims[c]} needs every remaining neighbour; ${unknown.length} mine(s) placed`,
          mines: unknown.slice(),
        });
        progress = true;
        continue loop;
      }
    }

    // ---- mine-budget bookkeeping
    if (reason === null) {
      const openMineCells: number[] = [];
      for (let i = 0; i < g.size; i++) if (mine[i] === UNKNOWN) openMineCells.push(i);
      if (openMineCells.length > 0) {
        if (minesFound === M) {
          for (const n of openMineCells) setClear(n);
          steps.push({
            technique: 'mine-budget-clear',
            cell: openMineCells[0],
            detail: `all ${M} buried mine(s) located; every other cell is clear`,
            clears: openMineCells.slice(),
          });
          progress = true;
          continue;
        }
        if (openMineCells.length === M - minesFound) {
          for (const n of openMineCells) setMine(n);
          steps.push({
            technique: 'mine-count-fill',
            cell: openMineCells[0],
            detail: `${M - minesFound} mine(s) left and exactly ${openMineCells.length} cell(s) can hold them`,
            mines: openMineCells.slice(),
          });
          progress = true;
          continue;
        }
      }
    }

    if (minesFound > M && reason === null) {
      reason = `contradiction: ${minesFound} mines placed, budget is ${M}`;
    }
  }

  const liarsFound = filers.filter((c) => verdict[c] === LIAR).sort((a, b) => a - b);
  const minesList: number[] = [];
  for (let i = 0; i < g.size; i++) if (mine[i] === MINE && !isCrater[i]) minesList.push(i);
  minesList.sort((a, b) => a - b);

  const solvable = reason === null && liarsFound.length === L;
  if (!solvable && reason === null) {
    reason = `stuck after ${steps.length} step(s): ${liarsFound.length}/${L} liar(s) identified — the rest needs a guess or case split`;
  }

  let hardestTechnique: Technique | null = null;
  if (solvable) {
    let best = -1;
    for (const s of steps) {
      const rank = TECHNIQUE_ORDER.indexOf(s.technique);
      if (rank > best) {
        best = rank;
        hardestTechnique = s.technique;
      }
    }
  }

  let difficulty: Difficulty | null = null;
  if (solvable) {
    // Provisional bands. `reach` is steps per filing cell — a stand-in for how
    // much of the board you have to grind through by hand. A counting-argument
    // step, or a cascade longer than the board itself, is "hard"; recalibrate
    // once the manual 20-puzzle pass (step 5) gives real feel data.
    const usedCounting = steps.some((s) => COUNTING.has(s.technique));
    const reach = steps.length / Math.max(1, filers.length);
    if (usedCounting || reach > 0.9) difficulty = 'hard';
    else if (steps.length <= 3) difficulty = 'trivial';
    else if (reach <= 0.45) difficulty = 'easy';
    else difficulty = 'medium';
  }

  return {
    solvable,
    difficulty,
    hardestTechnique,
    steps,
    liarsFound,
    minesFound: minesList,
    minesComplete: minesList.length === M,
    reason: solvable ? null : reason,
  };
}
