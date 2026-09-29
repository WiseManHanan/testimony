import { getGeometry, label, parseLabel, computeTruthfulClaims } from './board.ts';
import { solve, solveBruteForce, deriveLiars, hasUniqueSolution } from './solver.ts';
import { generate, generateTier, puzzleFromGrid, seededRng, TIERS, type TierName } from './generator.ts';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- geometry

section('Geometry');
{
  const g = getGeometry(3, 3);
  check('centre cell has 8 neighbours', g.neighbours[4].length === 8);
  check('corner cell has 3 neighbours', g.neighbours[0].length === 3);
  check('edge cell has 5 neighbours', g.neighbours[1].length === 5);
  check('labels round-trip', label(g, 5) === 'B3' && parseLabel(g, 'B3') === 5);

  const g8 = getGeometry(8, 8);
  let total = 0;
  for (let i = 0; i < g8.size; i++) total += g8.neighbours[i].length;
  // Adjacency is symmetric, so the total must be even.
  check('8x8 adjacency is symmetric', total % 2 === 0);
}

// ------------------------------------------------------- the tutorial case

section('Tutorial board (design doc §3)');
{
  // X = crater at A1. M = 1 buried mine, L = 1 liar.
  const puzzle = puzzleFromGrid(
    [
      ['X', 2, 1],
      [1, 2, 0],
      [2, 1, 1],
    ],
    1,
    1
  );
  const g = getGeometry(3, 3);
  const result = solve(puzzle);

  check('exactly one solution', result.solutions.length === 1,
    `got ${result.solutions.length}`);

  const mines = result.solutions[0] ?? [];
  check('mine is at B3', mines.length === 1 && label(g, mines[0]) === 'B3',
    `got ${mines.map((m) => label(g, m)).join(',')}`);

  const liars = deriveLiars(puzzle, mines);
  check('liar is C1', liars.length === 1 && label(g, liars[0]) === 'C1',
    `got ${liars.map((l) => label(g, l)).join(',')}`);

  // The doc's step 1 argument: C1 over-claims beyond the board's mine budget.
  const c1 = parseLabel(g, 'C1');
  const c1SeesCrater = g.neighbours[c1].includes(parseLabel(g, 'A1'));
  check('C1 is not adjacent to the crater', !c1SeesCrater);
  check('C1 claim exceeds total mine budget', puzzle.claims[c1] > puzzle.mineCount);
}

// -------------------------------------------- solver vs. brute force oracle

section('Solver agrees with brute-force oracle');
{
  const rng = seededRng(20260906);
  let compared = 0;
  let mismatches = 0;

  for (let trial = 0; trial < 300; trial++) {
    const width = 4 + Math.floor(rng() * 2);
    const height = 4 + Math.floor(rng() * 2);
    const g = getGeometry(width, height);
    const cells = Array.from({ length: g.size }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    const craterCount = 1 + Math.floor(rng() * 2);
    const mineCount = 1 + Math.floor(rng() * 3);
    const liarCount = Math.floor(rng() * 3);

    const craters = cells.slice(0, craterCount).sort((a, b) => a - b);
    const mines = cells.slice(craterCount, craterCount + mineCount).sort((a, b) => a - b);
    const claims = computeTruthfulClaims(g, craters, mines);

    // Corrupt a few claims arbitrarily; we do not care if it stays solvable,
    // only that both solvers agree on the answer.
    const filers = cells.filter((c) => !craters.includes(c));
    for (let k = 0; k < liarCount; k++) {
      const target = filers[Math.floor(rng() * filers.length)];
      claims[target] = Math.floor(rng() * 9);
    }

    const puzzle = { width, height, craters, claims, mineCount, liarCount };
    const fast = solve(puzzle).solutions.map((s) => s.join(',')).sort();
    const slow = solveBruteForce(puzzle).map((s) => s.join(',')).sort();

    compared++;
    if (fast.join('|') !== slow.join('|')) mismatches++;
  }

  check(`${compared} random boards match the oracle`, mismatches === 0,
    `${mismatches} mismatches`);
}

// ------------------------------------------------------ generator contract

section('Generator');
{
  const tiers: TierName[] = ['tutorial', 'junior', 'senior', 'fraudUnit', 'internalAffairs'];

  for (const tier of tiers) {
    const rng = seededRng(1234 + tier.length);
    const started = Date.now();
    const generated = generate({ ...TIERS[tier], rng, maxAttempts: 4000 });
    const elapsed = Date.now() - started;

    if (!generated) {
      check(`${tier}: produced a puzzle`, false, 'generator returned null');
      continue;
    }

    const { puzzle, solution } = generated;
    const solved = solve(puzzle, { limit: 2 });

    check(
      `${tier}: unique solution (${elapsed}ms)`,
      solved.solutions.length === 1,
      `got ${solved.solutions.length}`
    );
    check(
      `${tier}: solver recovers the planted mines`,
      solved.solutions[0]?.join(',') === solution.mines.join(',')
    );
    check(
      `${tier}: liar count matches the stated budget`,
      deriveLiars(puzzle, solution.mines).length === puzzle.liarCount
    );
    check(
      `${tier}: derived liars match the planted liars`,
      deriveLiars(puzzle, solution.mines).join(',') === solution.liars.join(',')
    );
    check(
      `${tier}: craters file no claims`,
      puzzle.craters.every((c) => puzzle.claims[c] === -1)
    );
  }
}

// ------------------------------------------------------------- batch sanity

section('Batch: 40 senior-tier cases');
{
  const rng = seededRng(99);
  let produced = 0;
  let unique = 0;
  const started = Date.now();

  for (let i = 0; i < 40; i++) {
    const generated = generateTier('senior', rng);
    if (!generated) continue;
    produced++;
    if (hasUniqueSolution(generated.puzzle)) unique++;
  }

  const elapsed = Date.now() - started;
  check(`produced 40/40 (${elapsed}ms total)`, produced === 40, `got ${produced}`);
  check('all 40 uniquely solvable', unique === produced);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
