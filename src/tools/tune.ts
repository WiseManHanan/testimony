/**
 * M/L tuning harness — DESIGN.md §8 step 5, "play 20 generated puzzles and
 * tune M/L ratios. Find out which feel elegant and which feel like brute-force
 * homework."
 *
 * Two ways in:
 *
 *   npm run tune -- play [tier|WxH] [--count N] [--seed S]
 *       Solve puzzles in the terminal against the real annotation layer.
 *       Every session is scored and you rate it elegant / fine / homework.
 *       The rating is logged next to a batch of automated structure metrics,
 *       so afterwards you can check which measurable properties your "homework"
 *       verdicts line up with.
 *
 *   npm run tune -- sweep [--count N] [--seed S] [--tiers a,b] [--histogram]
 *       Generate a batch across each tier and its M±1 / L±1 neighbours, with
 *       no human in the loop. Prints an aggregate table and writes per-puzzle
 *       JSONL. This is the wide net; `play` is the ground truth it calibrates.
 *
 *   npm run tune -- sample <tier|WxH> [--count N] [--seed S] [--mines M] ...
 *       One config, verbose per-puzzle output, histogram on by default.
 *
 * Nothing here consults difficulty via the real solver-against-the-answer —
 * that stays banned (CLAUDE.md). The metrics are all things a player could in
 * principle work out from the visible board.
 */

import { performance } from 'node:perf_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';

import { getGeometry, computeCounts, label, parseLabel } from '../core/board.ts';
import { solve } from '../core/solver.ts';
import { grade, type Difficulty, type Technique } from '../core/grader.ts';
import {
  generate,
  emptyTelemetry,
  seededRng,
  TIERS,
  type GenerateTelemetry,
  type TierName,
} from '../core/generator.ts';
import {
  CRATER,
  type GeneratedCase,
  type GeneratorConfig,
  type Puzzle,
  type Solution,
} from '../core/types.ts';
import {
  NoteHistory,
  canSubmit,
  cellsWithVerdict,
  cycleOrdnance,
  cycleVerdict,
  review,
  tally,
  type Notes,
  type Ordnance,
  type Verdict,
} from '../game/annotations.ts';

// --------------------------------------------------------------- CLI parsing

interface Flags {
  positional: string[];
  map: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const map = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        map.set(a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        map.set(a.slice(2), argv[++i]);
      } else {
        map.set(a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, map };
}

function strFlag(f: Flags, key: string, dflt: string): string {
  const v = f.map.get(key);
  return typeof v === 'string' ? v : dflt;
}

function numFlag(f: Flags, key: string, dflt: number): number {
  const v = f.map.get(key);
  return typeof v === 'string' && v.trim() !== '' ? Number(v) : dflt;
}

function boolFlag(f: Flags, key: string): boolean {
  const v = f.map.get(key);
  return v === true || v === 'true';
}

// ------------------------------------------------------------------- combos

interface Combo {
  label: string;
  width: number;
  height: number;
  craterCount: number;
  mineCount: number;
  liarCount: number;
}

function comboToConfig(c: Combo, f: Flags): GeneratorConfig {
  return {
    width: c.width,
    height: c.height,
    craterCount: c.craterCount,
    mineCount: c.mineCount,
    liarCount: c.liarCount,
    maxAttempts: numFlag(f, 'attempts', 2000),
  };
}

function resolveCombo(name: string | undefined, f: Flags): Combo {
  if (name && name in TIERS) {
    const base = TIERS[name as TierName];
    return { label: name, ...base };
  }
  const m = name ? /^(\d+)x(\d+)$/.exec(name) : null;
  const width = m ? Number(m[1]) : numFlag(f, 'width', 6);
  const height = m ? Number(m[2]) : numFlag(f, 'height', 6);
  const craterCount = numFlag(f, 'craters', 3);
  const mineCount = numFlag(f, 'mines', 3);
  const liarCount = numFlag(f, 'liars', 2);
  return {
    label: `${width}x${height}·C${craterCount}M${mineCount}L${liarCount}`,
    width,
    height,
    craterCount,
    mineCount,
    liarCount,
  };
}

/** Each tier plus its M-1..M+1 x L-1..L+1 neighbours, deduped. */
function sweepMatrix(tiers: TierName[]): Combo[] {
  const out: Combo[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    const base = TIERS[tier];
    for (const dM of [-1, 0, 1]) {
      for (const dL of [-1, 0, 1]) {
        const mineCount = base.mineCount + dM;
        const liarCount = base.liarCount + dL;
        if (mineCount < 1 || liarCount < 1) continue;
        if (base.craterCount + mineCount >= base.width * base.height) continue;
        const key = `${base.width}x${base.height}:${base.craterCount}:${mineCount}:${liarCount}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tag = dM === 0 && dL === 0 ? '' : ` M${mineCount}L${liarCount}`;
        out.push({
          label: `${tier}${tag}`,
          width: base.width,
          height: base.height,
          craterCount: base.craterCount,
          mineCount,
          liarCount,
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ metrics

/** Search space above this many placements: skip the O(placements) histogram. */
const DEFAULT_HISTCAP_BATCH = 2_000_000;
const DEFAULT_HISTCAP_PLAY = 8_000_000;

interface Metrics {
  naivePlacements: number;
  /**
   * Full mine placements the solver walks to a leaf without hitting the
   * violation bound. Near 1 for a well-formed puzzle — a weak difficulty
   * signal, kept mostly as a sanity check. Lean on nearMissRatio / trivial*.
   */
  solveLeaves: number;
  solveMs: number;
  /** solveLeaves / naivePlacements — how much the solver's pruning bought. */
  pruneRatio: number;
  /** Cells provably lying from the mine budget alone (claim above the ceiling). */
  freeOverClaims: number;
  /** Cells provably lying from visible craters alone (claim below the floor). */
  freeUnderClaims: number;
  /** Board fraction pinned down by trivial propagation once the L liars are known. */
  trivialCoverage: number;
  /** True if that propagation alone finishes the board. */
  trivialFullSolve: boolean;
  /** (placements one liar off the truth) / (all placements), or null if not computed. */
  nearMissRatio: number | null;
  histAtL: number | null;
  histAtLminus1: number | null;
  histAtLplus1: number | null;
  /* --- core/grader.ts: the real step-6 verdict, all L liars found by human technique --- */
  humanSolvable: boolean;
  humanDifficulty: Difficulty | null;
  humanHardest: Technique | null;
  humanSteps: number;
  humanMinesComplete: boolean;
}

function nCr(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  const k = Math.min(r, n - r);
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < k; i++) {
    num *= BigInt(n - i);
    den *= BigInt(i + 1);
  }
  return Number(num / den);
}

/**
 * Contradictions a player can spot with no deduction at all — just the claim,
 * the visible craters, and M. DESIGN.md §2 calls these the tutorial hooks.
 */
function freeContradictions(puzzle: Puzzle): { over: number; under: number } {
  const g = getGeometry(puzzle.width, puzzle.height);
  const craterSet = new Set(puzzle.craters);
  let over = 0;
  let under = 0;
  for (let i = 0; i < g.size; i++) {
    if (puzzle.claims[i] === CRATER) continue;
    const adj = g.neighbours[i];
    let adjCraters = 0;
    for (let k = 0; k < adj.length; k++) if (craterSet.has(adj[k])) adjCraters++;
    const buriable = adj.length - adjCraters;
    const ceiling = adjCraters + Math.min(puzzle.mineCount, buriable);
    const claim = puzzle.claims[i];
    if (claim > ceiling) over++;
    else if (claim < adjCraters) under++;
  }
  return { over, under };
}

/**
 * How far the board collapses under the two safest Minesweeper rules —
 * "claim satisfied, rest is clear" and "only just enough room, rest is mines" —
 * once the player knows which L cells lied and ignores their numbers.
 *
 * This is a floor on solvability, not the human-technique solver from step 6.
 * A puzzle this finishes is almost certainly "elegant"; one it barely touches
 * needs real case analysis.
 */
function trivialCoverage(puzzle: Puzzle, solution: Solution): { coverage: number; full: boolean } {
  const g = getGeometry(puzzle.width, puzzle.height);
  const craterSet = new Set(puzzle.craters);
  const liarSet = new Set(solution.liars);
  // 0 = unknown, 1 = mine, 2 = clear.
  const state = new Uint8Array(g.size);
  for (const c of puzzle.craters) state[c] = 1;

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < g.size; i++) {
      if (craterSet.has(i) || liarSet.has(i)) continue;
      if (puzzle.claims[i] === CRATER) continue;
      const adj = g.neighbours[i];
      let knownMines = 0;
      const unknown: number[] = [];
      for (let k = 0; k < adj.length; k++) {
        const s = state[adj[k]];
        if (s === 1) knownMines++;
        else if (s === 0) unknown.push(adj[k]);
      }
      if (unknown.length === 0) continue;
      const need = puzzle.claims[i] - knownMines;
      if (need === 0) {
        for (const u of unknown) state[u] = 2;
        changed = true;
      } else if (need === unknown.length) {
        for (const u of unknown) state[u] = 1;
        changed = true;
      }
    }
  }

  let decided = 0;
  let nonCrater = 0;
  let minesFound = 0;
  for (let i = 0; i < g.size; i++) {
    if (craterSet.has(i)) continue;
    nonCrater++;
    if (state[i] !== 0) decided++;
    if (state[i] === 1) minesFound++;
  }
  return {
    coverage: nonCrater === 0 ? 1 : decided / nonCrater,
    full: decided === nonCrater && minesFound === puzzle.mineCount,
  };
}

/**
 * Tally |liar_set(H)| over every mine placement H, not just the valid ones.
 * Placements sitting at L-1 or L+1 are the "so close" states a player has to
 * rule out one at a time — a board thick with them reads as homework.
 * Returns null when the search space is over `cap`.
 */
function violationHistogram(puzzle: Puzzle, cap: number): { hist: number[]; total: number } | null {
  const g = getGeometry(puzzle.width, puzzle.height);
  const craterSet = new Set(puzzle.craters);
  const candidates: number[] = [];
  for (let i = 0; i < g.size; i++) if (!craterSet.has(i)) candidates.push(i);

  const total = nCr(candidates.length, puzzle.mineCount);
  if (total > cap) return null;

  const counts = computeCounts(g, puzzle.craters);
  const claims = puzzle.claims;
  const filing: number[] = [];
  for (let i = 0; i < g.size; i++) if (claims[i] !== CRATER) filing.push(i);

  const hist = new Array<number>(g.size + 1).fill(0);

  function place(idx: number, delta: number): void {
    const a = g.neighbours[idx];
    for (let k = 0; k < a.length; k++) counts[a[k]] += delta;
  }
  function dfs(start: number, left: number): void {
    if (left === 0) {
      let viol = 0;
      for (let k = 0; k < filing.length; k++) {
        if (counts[filing[k]] !== claims[filing[k]]) viol++;
      }
      hist[viol]++;
      return;
    }
    for (let i = start; i <= candidates.length - left; i++) {
      const idx = candidates[i];
      place(idx, 1);
      dfs(i + 1, left - 1);
      place(idx, -1);
    }
  }
  dfs(0, puzzle.mineCount);
  return { hist, total };
}

function computeMetrics(gc: GeneratedCase, histCap: number): Metrics {
  const { puzzle, solution } = gc;
  const g = getGeometry(puzzle.width, puzzle.height);
  const naive = nCr(g.size - puzzle.craters.length, puzzle.mineCount);

  const t0 = performance.now();
  const solved = solve(puzzle);
  const solveMs = performance.now() - t0;

  const fc = freeContradictions(puzzle);
  const triv = trivialCoverage(puzzle, solution);
  const gr = grade(puzzle);

  let nearMissRatio: number | null = null;
  let histAtL: number | null = null;
  let histAtLminus1: number | null = null;
  let histAtLplus1: number | null = null;
  if (histCap > 0) {
    const h = violationHistogram(puzzle, histCap);
    if (h) {
      const L = puzzle.liarCount;
      histAtL = h.hist[L] ?? 0;
      histAtLminus1 = L - 1 >= 0 ? (h.hist[L - 1] ?? 0) : 0;
      histAtLplus1 = h.hist[L + 1] ?? 0;
      nearMissRatio = h.total > 0 ? (histAtLminus1 + histAtLplus1) / h.total : 0;
    }
  }

  return {
    naivePlacements: naive,
    solveLeaves: solved.nodesVisited,
    solveMs,
    pruneRatio: naive > 0 ? solved.nodesVisited / naive : 0,
    freeOverClaims: fc.over,
    freeUnderClaims: fc.under,
    trivialCoverage: triv.coverage,
    trivialFullSolve: triv.full,
    nearMissRatio,
    histAtL,
    histAtLminus1,
    histAtLplus1,
    humanSolvable: gr.solvable,
    humanDifficulty: gr.difficulty,
    humanHardest: gr.hardestTechnique,
    humanSteps: gr.steps.length,
    humanMinesComplete: gr.minesComplete,
  };
}

// ------------------------------------------------------------------ logging

function openLog(kind: string): string {
  mkdirSync('playlogs', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `playlogs/${kind}-${stamp}.jsonl`;
}

function fnv1a(src: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function puzzleId(puzzle: Puzzle): string {
  return fnv1a(`${puzzle.craters.join(',')}|${Array.from(puzzle.claims).join(',')}`)
    .toString(16)
    .padStart(8, '0');
}

// -------------------------------------------------------------- batch modes

interface PuzzleRecord {
  ts: string;
  mode: 'batch';
  label: string;
  seed: number;
  width: number;
  height: number;
  craterCount: number;
  mineCount: number;
  liarCount: number;
  puzzleId: string;
  genAttempts: number;
  genSolveCalls: number;
  genMs: number;
  rejectedNotUnique: number;
  rejectedPerturbationCollapsed: number;
  rejectedFewFilers: number;
  metrics: Metrics;
}

function buildRecord(
  combo: Combo,
  seed: number,
  gc: GeneratedCase,
  tel: GenerateTelemetry,
  genMs: number,
  metrics: Metrics
): PuzzleRecord {
  return {
    ts: new Date().toISOString(),
    mode: 'batch',
    label: combo.label,
    seed,
    width: combo.width,
    height: combo.height,
    craterCount: combo.craterCount,
    mineCount: combo.mineCount,
    liarCount: combo.liarCount,
    puzzleId: puzzleId(gc.puzzle),
    genAttempts: tel.attempts,
    genSolveCalls: tel.solveCalls,
    genMs,
    rejectedNotUnique: tel.rejectedNotUnique,
    rejectedPerturbationCollapsed: tel.rejectedPerturbationCollapsed,
    rejectedFewFilers: tel.rejectedFewFilers,
    metrics,
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pctile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function share(xs: boolean[]): number {
  return xs.length ? xs.filter(Boolean).length / xs.length : 0;
}

interface SummaryRow {
  label: string;
  dims: string;
  made: string;
  attMed: number;
  attP90: number;
  humanPct: number;
  hStepMed: number;
  hardPct: number;
  freePlus: number;
  freeAnyPct: number;
  trivCovMed: number;
  genMsMed: number;
  nearMiss: number | null;
}

function summarize(
  combo: Combo,
  recs: PuzzleRecord[],
  nulls: number,
  requested: number
): SummaryRow {
  const m = recs.map((r) => r.metrics);
  const nm = m.map((x) => x.nearMissRatio).filter((x): x is number => x !== null);
  const solvable = m.filter((x) => x.humanSolvable);
  return {
    label: combo.label,
    dims: `${combo.width}x${combo.height} C${combo.craterCount} M${combo.mineCount} L${combo.liarCount}`,
    made: `${recs.length}/${requested}${nulls ? ` (+${nulls} null)` : ''}`,
    attMed: median(recs.map((r) => r.genAttempts)),
    attP90: pctile(recs.map((r) => r.genAttempts), 0.9),
    humanPct: share(m.map((x) => x.humanSolvable)),
    hStepMed: median(solvable.map((x) => x.humanSteps)),
    hardPct: share(solvable.map((x) => x.humanDifficulty === 'hard')),
    freePlus: median(m.map((x) => x.freeOverClaims)),
    freeAnyPct: share(m.map((x) => x.freeOverClaims + x.freeUnderClaims > 0)),
    trivCovMed: median(m.map((x) => x.trivialCoverage)),
    genMsMed: median(recs.map((r) => r.genMs)),
    nearMiss: nm.length ? median(nm) : null,
  };
}

function printTable(rows: SummaryRow[]): void {
  const head = [
    'combo'.padEnd(22),
    'dims'.padEnd(16),
    'made'.padEnd(14),
    'att~'.padStart(6),
    'attP90'.padStart(7),
    'human%'.padStart(7),
    'hStep~'.padStart(7),
    'hard%'.padStart(6),
    'free+'.padStart(6),
    'free%'.padStart(6),
    'trivCov'.padStart(8),
    'gen ms'.padStart(7),
    'nearMiss'.padStart(9),
  ].join(' ');
  console.log('\n' + head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(22),
        r.dims.padEnd(16),
        r.made.padEnd(14),
        String(Math.round(r.attMed)).padStart(6),
        String(Math.round(r.attP90)).padStart(7),
        (r.humanPct * 100).toFixed(0).padStart(6) + '%',
        String(Math.round(r.hStepMed)).padStart(7),
        (r.hardPct * 100).toFixed(0).padStart(5) + '%',
        r.freePlus.toFixed(1).padStart(6),
        (r.freeAnyPct * 100).toFixed(0).padStart(5) + '%',
        (r.trivCovMed * 100).toFixed(0).padStart(7) + '%',
        r.genMsMed.toFixed(1).padStart(7),
        r.nearMiss === null ? 'n/a'.padStart(9) : r.nearMiss.toExponential(1).padStart(9),
      ].join(' ')
    );
  }
}

function printTableLegend(): void {
  console.log(`
reading the table
  att~ / attP90   generate() attempts to land one puzzle (median / 90th pct).
                  climbing fast down a column = that M/L ratio is too tight.
  human%          share the human-technique grader (core/grader.ts) can solve
                  WITHOUT guessing. This is the step-6 verdict; low = the ratio
                  produces puzzles that are unique but only crackable by case
                  analysis. Wire it into generate() with the game's tier set.
  hStep~ / hard%  among the human-solvable ones: median deduction steps, and the
                  share the grader banded 'hard'. Provisional bands.
  free+           median starting over-claim freebies (provable liars from M).
  free%           share of puzzles with >=1 free contradiction. 0% = no hook.
  trivCov         median board fraction settled by trivial propagation once the
                  L liars are known (a rough stand-in the grader now supersedes).
  nearMiss        median (placements one liar off the truth / all placements).
                  high = many "so close" states to eliminate -> homework.
                  n/a = search space above --histcap (default 2e6; sweep off by
                  default, pass --histogram).`);
}

function runBatch(combos: Combo[], f: Flags, kind: string, verbose: boolean): void {
  const count = numFlag(f, 'count', kind === 'sweep' ? 15 : 20);
  const seed = numFlag(f, 'seed', 0xc0ffee);
  const defaultCap = kind === 'sweep' ? 0 : DEFAULT_HISTCAP_BATCH;
  const histCap = boolFlag(f, 'histogram')
    ? numFlag(f, 'histcap', DEFAULT_HISTCAP_BATCH)
    : numFlag(f, 'histcap', defaultCap);
  const logPath = openLog(kind);
  const rows: SummaryRow[] = [];

  console.log(`${kind}: ${combos.length} combo(s) x ${count} puzzles, seed ${seed}`);

  for (const combo of combos) {
    // Per-combo seed so each row is reproducible on its own and re-ordering or
    // filtering the matrix doesn't shift another row's puzzles.
    const rng = seededRng((seed ^ fnv1a(combo.label)) >>> 0);
    const recs: PuzzleRecord[] = [];
    let nulls = 0;
    if (verbose) console.log(`  ${combo.label}`);
    else process.stdout.write(`  ${combo.label.padEnd(24)} `);

    for (let i = 0; i < count; i++) {
      const tel = emptyTelemetry();
      const t0 = performance.now();
      const gc = generate({ ...comboToConfig(combo, f), rng }, tel);
      const genMs = performance.now() - t0;
      if (!gc) {
        nulls++;
        process.stdout.write('x');
        continue;
      }
      const metrics = computeMetrics(gc, histCap);
      const rec = buildRecord(combo, seed, gc, tel, genMs, metrics);
      recs.push(rec);
      appendFileSync(logPath, JSON.stringify(rec) + '\n');
      if (verbose) {
        const human = metrics.humanSolvable
          ? `human ${metrics.humanDifficulty}/${metrics.humanSteps}st via ${metrics.humanHardest}`
          : 'human NO (needs a guess)';
        console.log(
          `    #${String(i + 1).padStart(2)} ${rec.puzzleId}  att ${String(tel.attempts).padStart(4)}` +
            `  free+/- ${metrics.freeOverClaims}/${metrics.freeUnderClaims}` +
            `  ${human}` +
            (metrics.nearMissRatio === null ? '' : `  nearMiss ${metrics.nearMissRatio.toExponential(1)}`)
        );
      } else {
        process.stdout.write('.');
      }
    }
    process.stdout.write('\n');
    rows.push(summarize(combo, recs, nulls, count));
  }

  printTable(rows);
  printTableLegend();
  console.log(`\nper-puzzle JSONL: ${logPath}`);
}

function runSweep(f: Flags): void {
  const tiers = (strFlag(f, 'tiers', '')
    ? strFlag(f, 'tiers', '').split(',').map((s) => s.trim())
    : Object.keys(TIERS)) as TierName[];
  runBatch(sweepMatrix(tiers), f, 'sweep', false);
}

function runSample(positional: string[], f: Flags): void {
  runBatch([resolveCombo(positional[0], f)], f, 'sample', true);
}

// ------------------------------------------------------------- interactive

const V_GLYPH: Record<Verdict, string> = {
  none: '·',
  approved: 'A',
  questionable: 'Q',
  fraud: 'F',
};
const O_GLYPH: Record<Ordnance, string> = { none: ' ', clear: '-', mine: '*', maybe: '?' };

const V_ALIAS: Record<string, Verdict> = {
  n: 'none', none: 'none',
  a: 'approved', approved: 'approved',
  q: 'questionable', questionable: 'questionable',
  f: 'fraud', fraud: 'fraud',
};
const O_ALIAS: Record<string, Ordnance> = {
  n: 'none', none: 'none', x: 'none',
  c: 'clear', clear: 'clear',
  m: 'mine', mine: 'mine',
  y: 'maybe', '?': 'maybe', maybe: 'maybe',
};

function renderBoard(puzzle: Puzzle, notes: Notes, reveal?: Solution): string {
  const craterSet = new Set(puzzle.craters);
  const mineSet = reveal ? new Set(reveal.mines) : null;
  const liarSet = reveal ? new Set(reveal.liars) : null;
  const W = 7;

  let header = '    ';
  for (let c = 0; c < puzzle.width; c++) header += String(c + 1).padEnd(W);
  const lines = [header];

  for (let r = 0; r < puzzle.height; r++) {
    let line = ` ${String.fromCharCode(65 + r)}  `;
    for (let c = 0; c < puzzle.width; c++) {
      const i = r * puzzle.width + c;
      if (craterSet.has(i)) {
        line += '###'.padEnd(W);
        continue;
      }
      const claim = String(puzzle.claims[i]);
      if (reveal) {
        const truth = (mineSet!.has(i) ? 'M' : '') + (liarSet!.has(i) ? 'L' : '');
        line += `${claim}${truth || '·'}`.padEnd(W);
      } else {
        const n = notes.cells[i];
        line += `${claim}${V_GLYPH[n.verdict]}${O_GLYPH[n.ordnance]}`.padEnd(W);
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * One line at a time from the interface, prompt written by hand. Uses the
 * async iterator rather than `rl.question` so buffered input (a piped script,
 * a fast paste) is not dropped. Resolves to null at end of input.
 */
type Ask = (prompt: string) => Promise<string | null>;

function makeAsk(rl: Interface): Ask {
  const it = rl[Symbol.asyncIterator]();
  return async (prompt: string) => {
    process.stdout.write(prompt);
    const { value, done } = await it.next();
    return done ? null : (value as string);
  };
}

function printPlayHelp(): void {
  console.log(`
  a1            cycle verdict  on A1   (none -> approved -> questionable -> fraud)
  .a1           cycle ordnance on A1   (none -> clear -> mine -> maybe)
  a1=f  .a1=m   set directly           verdict a/q/f/n   ordnance c/m/y/n
  w             show working (checks your marks vs the filed claims only)
  t             tallies              b   redraw board
  u / r         undo / redo
  submit        file determination (needs exactly L fraud verdicts)
  give          give up and reveal the answer
  quit          stop the whole session`);
}

interface PlayRecord {
  ts: string;
  mode: 'play';
  label: string;
  seed: number;
  width: number;
  height: number;
  craterCount: number;
  mineCount: number;
  liarCount: number;
  puzzleId: string;
  genAttempts: number;
  outcome: 'correct' | 'incorrect' | 'gaveup';
  elapsedMs: number;
  moves: number;
  undos: number;
  redos: number;
  showWorkingCalls: number;
  liarsCaught: number;
  liarsMissed: number;
  falseAccusations: number;
  minesMarkedRight: number;
  minesTotal: number;
  rating: 'elegant' | 'fine' | 'homework' | 'skip';
  note: string;
  metrics: Metrics;
}

function applyCellCommand(raw: string, puzzle: Puzzle, history: NoteHistory): boolean {
  const g = getGeometry(puzzle.width, puzzle.height);
  let s = raw.trim();
  let axis: 'verdict' | 'ordnance' = 'verdict';
  if (s.startsWith('.')) {
    axis = 'ordnance';
    s = s.slice(1);
  }
  let target: string | null = null;
  const eq = s.indexOf('=');
  if (eq >= 0) {
    target = s.slice(eq + 1).trim().toLowerCase();
    s = s.slice(0, eq).trim();
  }

  let idx: number;
  try {
    idx = parseLabel(g, s);
  } catch {
    return false;
  }
  if (puzzle.claims[idx] === CRATER) {
    console.log('  that cell is a crater — it files no claim');
    return false;
  }

  if (target !== null) {
    if (axis === 'verdict') {
      const v = V_ALIAS[target];
      if (!v) {
        console.log('  verdict must be one of a/q/f/n');
        return false;
      }
      history.apply((d) => {
        d.cells[idx].verdict = v;
      });
    } else {
      const o = O_ALIAS[target];
      if (!o) {
        console.log('  ordnance must be one of c/m/y/n');
        return false;
      }
      history.apply((d) => {
        d.cells[idx].ordnance = o;
      });
    }
    return true;
  }

  history.apply((d) => {
    const cell = d.cells[idx];
    if (axis === 'verdict') cell.verdict = cycleVerdict(cell.verdict);
    else cell.ordnance = cycleOrdnance(cell.ordnance);
  });
  return true;
}

function scorePlay(gc: GeneratedCase, notes: Notes): {
  caught: number;
  missed: number;
  falseAccusations: number;
  minesRight: number;
  correct: boolean;
} {
  const fraudMarks = cellsWithVerdict(notes, 'fraud');
  const liarSet = new Set(gc.solution.liars);
  const caught = fraudMarks.filter((i) => liarSet.has(i)).length;
  const falseAccusations = fraudMarks.filter((i) => !liarSet.has(i)).length;
  const missed = gc.solution.liars.length - caught;

  const mineSet = new Set(gc.solution.mines);
  let minesRight = 0;
  for (let i = 0; i < notes.cells.length; i++) {
    if (notes.cells[i].ordnance === 'mine' && mineSet.has(i)) minesRight++;
  }
  return {
    caught,
    missed,
    falseAccusations,
    minesRight,
    correct: caught === gc.solution.liars.length && falseAccusations === 0,
  };
}

async function askRating(ask: Ask): Promise<PlayRecord['rating']> {
  while (true) {
    const raw = await ask('\n  feel? [e]legant / [f]ine / [h]omework / [s]kip: ');
    if (raw === null) return 'skip';
    const a = raw.trim().toLowerCase();
    if (a === 'e' || a === 'elegant') return 'elegant';
    if (a === 'f' || a === 'fine') return 'fine';
    if (a === 'h' || a === 'homework') return 'homework';
    if (a === 's' || a === 'skip' || a === '') return 'skip';
  }
}

/** Returns null if the player asked to quit the whole session. */
async function playOne(
  ask: Ask,
  combo: Combo,
  seed: number,
  gc: GeneratedCase,
  tel: GenerateTelemetry,
  histCap: number
): Promise<PlayRecord | null> {
  const { puzzle } = gc;
  const size = puzzle.width * puzzle.height;
  const history = new NoteHistory(size);

  let moves = 0;
  let undos = 0;
  let redos = 0;
  let showWorkingCalls = 0;
  const start = performance.now();

  console.log('\n' + '='.repeat(52));
  console.log(
    `case ${combo.label}  seed ${seed}   ${puzzle.width}x${puzzle.height}   ` +
      `M=${puzzle.mineCount} buried   L=${puzzle.liarCount} liars`
  );
  printPlayHelp();
  console.log('\n' + renderBoard(puzzle, history.current) + '\n');

  let outcome: PlayRecord['outcome'] = 'gaveup';

  game: while (true) {
    const input = await ask('> ');
    if (input === null) {
      console.log('  (end of input — this puzzle not logged)');
      return null;
    }
    const raw = input.trim();
    if (raw === '') {
      console.log(renderBoard(puzzle, history.current));
      continue;
    }
    const cmd = raw.split(/\s+/)[0].toLowerCase();

    switch (cmd) {
      case 'help':
      case '?':
        printPlayHelp();
        break;
      case 'b':
        console.log(renderBoard(puzzle, history.current));
        break;
      case 't': {
        const ta = tally(puzzle, history.current);
        console.log(
          `  verdicts  approved ${ta.approved}  questionable ${ta.questionable}  ` +
            `fraud ${ta.fraud}/${puzzle.liarCount}`
        );
        console.log(
          `  ordnance  mine ${ta.mines}/${puzzle.mineCount}  maybe ${ta.maybeMines}  ` +
            `clear ${ta.cleared}  untouched ${ta.untouched}`
        );
        break;
      }
      case 'w': {
        showWorkingCalls++;
        const rv = review(puzzle, history.current);
        if (rv.conflicts.length === 0) {
          console.log('  no conflicts with the filed claims (bookkeeping only — the answer is never consulted)');
        } else {
          console.log('  claims your marks cannot satisfy (a mark is wrong, or that claimant lied):');
          for (const cf of rv.conflicts) {
            console.log(
              `    ${label(getGeometry(puzzle.width, puzzle.height), cf.cell)}  ${cf.kind}` +
                `  marked ${cf.marked}, open ${cf.open}` +
                (cf.disputesOwnApproval ? '  — you approved this one' : '')
            );
          }
        }
        if (rv.overMineBudget) console.log('    ! more mine marks than M');
        if (rv.overFraudBudget) console.log('    ! more fraud verdicts than L');
        break;
      }
      case 'u':
        if (history.canUndo) {
          history.undo();
          undos++;
        }
        console.log(renderBoard(puzzle, history.current));
        break;
      case 'r':
        if (history.canRedo) {
          history.redo();
          redos++;
        }
        console.log(renderBoard(puzzle, history.current));
        break;
      case 'submit':
        if (!canSubmit(puzzle, history.current)) {
          console.log(
            `  need exactly ${puzzle.liarCount} fraud verdicts (have ${tally(puzzle, history.current).fraud})`
          );
          break;
        }
        outcome = scorePlay(gc, history.current).correct ? 'correct' : 'incorrect';
        break game;
      case 'give':
      case 'giveup':
        outcome = 'gaveup';
        break game;
      case 'quit':
      case 'abort':
        console.log('  (session stopped — this puzzle not logged)');
        return null;
      default:
        if (applyCellCommand(raw, puzzle, history)) {
          moves++;
          console.log(renderBoard(puzzle, history.current));
        } else {
          console.log('  ? unrecognised — type "help"');
        }
    }
  }

  const elapsedMs = performance.now() - start;
  const s = scorePlay(gc, history.current);

  console.log('\n' + renderBoard(puzzle, history.current, gc.solution));
  console.log(
    `\n  outcome: ${outcome.toUpperCase()}   ` +
      `liars ${s.caught}/${gc.solution.liars.length} caught, ${s.falseAccusations} false` +
      `   mines ${s.minesRight}/${gc.solution.mines.length} marked right`
  );
  console.log(`  time ${(elapsedMs / 1000).toFixed(0)}s   moves ${moves}   undo ${undos}   show-working ${showWorkingCalls}`);

  const rating = await askRating(ask);
  const note = ((await ask('  note (optional): ')) ?? '').trim();

  return {
    ts: new Date().toISOString(),
    mode: 'play',
    label: combo.label,
    seed,
    width: combo.width,
    height: combo.height,
    craterCount: combo.craterCount,
    mineCount: combo.mineCount,
    liarCount: combo.liarCount,
    puzzleId: puzzleId(puzzle),
    genAttempts: tel.attempts,
    outcome,
    elapsedMs,
    moves,
    undos,
    redos,
    showWorkingCalls,
    liarsCaught: s.caught,
    liarsMissed: s.missed,
    falseAccusations: s.falseAccusations,
    minesMarkedRight: s.minesRight,
    minesTotal: gc.solution.mines.length,
    rating,
    note,
    metrics: computeMetrics(gc, histCap),
  };
}

async function runPlay(positional: string[], f: Flags): Promise<void> {
  const combo = resolveCombo(positional[0] ?? 'senior', f);
  const seedBase = numFlag(f, 'seed', Date.now() & 0xffffffff);
  const series = numFlag(f, 'count', 1);
  const histCap = numFlag(f, 'histcap', DEFAULT_HISTCAP_PLAY);
  const logPath = openLog('play');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsk(rl);

  console.log(`play: ${combo.label}  (${series} puzzle${series === 1 ? '' : 's'})   log -> ${logPath}`);

  try {
    for (let n = 0; n < series; n++) {
      const seed = seedBase + n;
      const tel = emptyTelemetry();
      const gc = generate({ ...comboToConfig(combo, f), rng: seededRng(seed) }, tel);
      if (!gc) {
        console.log(`  ${combo.label} failed to generate at seed ${seed} — loosen M/L or raise --attempts`);
        break;
      }
      const rec = await playOne(ask, combo, seed, gc, tel, histCap);
      if (!rec) break;
      appendFileSync(logPath, JSON.stringify(rec) + '\n');

      if (n + 1 < series) {
        const again = await ask('\nnext puzzle? [Enter] / q: ');
        if (again === null || again.trim().toLowerCase() === 'q' || again.trim().toLowerCase() === 'quit') break;
      }
    }
  } finally {
    rl.close();
  }
  console.log(`\nsession log: ${logPath}`);
}

// -------------------------------------------------------------------- entry

function printUsage(): void {
  console.log(`testimony M/L tuning harness (DESIGN.md §8 step 5)

  npm run tune -- play [tier|WxH] [--count N] [--seed S]
      Solve puzzles in the terminal, score them, rate elegant/fine/homework.
      Each session is logged with its structure metrics for later correlation.

  npm run tune -- sweep [--count N] [--seed S] [--tiers a,b] [--histogram]
      Batch-generate each tier plus its M±1 / L±1 neighbours. Prints a table,
      writes per-puzzle JSONL. No human in the loop.

  npm run tune -- sample <tier|WxH> [--count N] [--mines M] [--liars L] ...
      One config, verbose, violation histogram on by default.

  tiers: ${Object.keys(TIERS).join(', ')}
  explicit board: WxH with --craters --mines --liars   (e.g. 7x7 --mines 4 --liars 2)
  other flags: --attempts (generate() cap, default 2000), --histcap (default 2e6)

  logs are written to playlogs/  (git-ignored)`);
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  const cmd = f.positional[0] ?? 'help';
  const rest = f.positional.slice(1);
  switch (cmd) {
    case 'sweep':
      runSweep(f);
      break;
    case 'sample':
      runSample(rest, f);
      break;
    case 'play':
      await runPlay(rest, f);
      break;
    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
