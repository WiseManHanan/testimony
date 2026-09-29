import { getGeometry, computeTruthfulClaims, filingCells } from './board.ts';
import { solve, deriveLiars } from './solver.ts';
import { grade } from './grader.ts';
import { CRATER, type GeneratedCase, type GeneratorConfig, type Puzzle } from './types.ts';

/** Mulberry32 — small seedable PRNG so generation can be made deterministic. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Perturb a truthful claim into a fraudulent one.
 *
 * Biased toward over-claiming (+1, +2). Over-claims produce clean budget
 * contradictions — "you claim 2 mines adjacent but only 1 mine exists on the
 * whole board" — which are the satisfying catches. They also read as a greedy
 * claimant, which is thematically correct.
 */
function fraudulentClaim(truth: number, rng: () => number): number {
  const weighted: number[] = [];
  for (let value = 0; value <= 8; value++) {
    if (value === truth) continue;
    const weight = value === truth + 1 ? 5 : value === truth + 2 ? 3 : 1;
    for (let w = 0; w < weight; w++) weighted.push(value);
  }
  return weighted[Math.floor(rng() * weighted.length)];
}

/**
 * Optional counters filled in by `generate`. Purely diagnostic — used by the
 * M/L tuning harness (src/tools/tune.ts) to see how hard a given ratio is to
 * satisfy. Rejection rate, not solve speed, is the real cost driver, so this
 * breaks the rejections down by cause.
 */
export interface GenerateTelemetry {
  attempts: number;
  rejectedFewFilers: number;
  rejectedPerturbationCollapsed: number;
  rejectedNotUnique: number;
  rejectedNotHumanSolvable: number;
  solveCalls: number;
  gradeCalls: number;
}

export function emptyTelemetry(): GenerateTelemetry {
  return {
    attempts: 0,
    rejectedFewFilers: 0,
    rejectedPerturbationCollapsed: 0,
    rejectedNotUnique: 0,
    rejectedNotHumanSolvable: 0,
    solveCalls: 0,
    gradeCalls: 0,
  };
}

/**
 * Generate a puzzle with a guaranteed unique solution.
 *
 * Strategy is generate-and-reject: build a random truth, corrupt L claims,
 * then ask the solver whether the result is uniquely solvable. Discard if not.
 * Rejection rates are high for tight M/L ratios, which is why maxAttempts
 * exists. Returns null if it cannot find one.
 *
 * Pass `telemetry` (from `emptyTelemetry()`) to have the loop tally attempts
 * and rejection causes. It is mutated in place and never changes behaviour.
 */
export function generate(
  config: GeneratorConfig,
  telemetry?: GenerateTelemetry
): GeneratedCase | null {
  const {
    width,
    height,
    craterCount,
    mineCount,
    liarCount,
    maxAttempts = 2000,
    rng = Math.random,
    requireHumanSolvable = false,
  } = config;

  const geometry = getGeometry(width, height);
  const allCells = Array.from({ length: geometry.size }, (_, i) => i);

  if (craterCount + mineCount >= geometry.size) {
    throw new Error('Too many mines for this board size.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (telemetry) telemetry.attempts++;
    const picks = shuffled(allCells, rng);
    const craters = picks.slice(0, craterCount).sort((a, b) => a - b);
    const mines = picks.slice(craterCount, craterCount + mineCount).sort((a, b) => a - b);

    const claims = computeTruthfulClaims(geometry, craters, mines);

    const filers = filingCells(geometry, craters);
    if (filers.length < liarCount) {
      if (telemetry) telemetry.rejectedFewFilers++;
      continue;
    }
    const liars = shuffled(filers, rng).slice(0, liarCount).sort((a, b) => a - b);

    for (const liar of liars) {
      claims[liar] = fraudulentClaim(claims[liar], rng);
    }

    const puzzle: Puzzle = { width, height, craters, claims, mineCount, liarCount };

    // Sanity: our own truth must register as a valid solution. If a "liar"
    // was perturbed into a value that happens to still be correct, or the
    // arithmetic drifted, this catches it.
    if (deriveLiars(puzzle, mines).length !== liarCount) {
      if (telemetry) telemetry.rejectedPerturbationCollapsed++;
      continue;
    }

    if (telemetry) telemetry.solveCalls++;
    const result = solve(puzzle, { limit: 2 });
    if (result.solutions.length !== 1) {
      if (telemetry) telemetry.rejectedNotUnique++;
      continue;
    }

    if (requireHumanSolvable) {
      if (telemetry) telemetry.gradeCalls++;
      if (!grade(puzzle).solvable) {
        if (telemetry) telemetry.rejectedNotHumanSolvable++;
        continue;
      }
    }

    return { puzzle, solution: { mines, liars } };
  }

  return null;
}

/** Standard difficulty tiers from the design doc. */
export const TIERS = {
  tutorial: { width: 3, height: 3, craterCount: 1, mineCount: 1, liarCount: 1 },
  junior: { width: 5, height: 5, craterCount: 2, mineCount: 2, liarCount: 1 },
  senior: { width: 6, height: 6, craterCount: 3, mineCount: 3, liarCount: 2 },
  fraudUnit: { width: 8, height: 8, craterCount: 4, mineCount: 5, liarCount: 3 },
  internalAffairs: { width: 8, height: 8, craterCount: 2, mineCount: 6, liarCount: 4 },
} as const satisfies Record<string, Omit<GeneratorConfig, 'rng' | 'maxAttempts'>>;

export type TierName = keyof typeof TIERS;

export function generateTier(
  tier: TierName,
  rng: () => number = Math.random,
  opts: Pick<GeneratorConfig, 'requireHumanSolvable' | 'maxAttempts'> = {}
): GeneratedCase | null {
  return generate({ ...TIERS[tier], rng, ...opts });
}

/** Build a puzzle by hand. Used for the fixed tutorial case and for tests. */
export function puzzleFromGrid(
  grid: readonly (number | 'X')[][],
  mineCount: number,
  liarCount: number
): Puzzle {
  const height = grid.length;
  const width = grid[0].length;
  const claims = new Int8Array(width * height);
  const craters: number[] = [];

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c;
      const cell = grid[r][c];
      if (cell === 'X') {
        craters.push(idx);
        claims[idx] = CRATER;
      } else {
        claims[idx] = cell;
      }
    }
  }

  return { width, height, craters, claims, mineCount, liarCount };
}
