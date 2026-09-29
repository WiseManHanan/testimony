import { getGeometry, label } from './board.ts';
import { solve, deriveLiars } from './solver.ts';
import {
  generate,
  puzzleFromGrid,
  seededRng,
  emptyTelemetry,
  TIERS,
  type TierName,
} from './generator.ts';
import { grade } from './grader.ts';

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

// ------------------------------------------------------ the tutorial board

section('Tutorial board grades as a clean human solve');
{
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
  const r = grade(puzzle);

  check('solvable by human technique', r.solvable, r.reason ?? '');
  check('names C1 as the only liar', r.liarsFound.length === 1 && label(g, r.liarsFound[0]) === 'C1',
    r.liarsFound.map((i) => label(g, i)).join(','));
  check('locates the mine under B3', r.minesComplete && r.minesFound.length === 1 && label(g, r.minesFound[0]) === 'B3',
    r.minesFound.map((i) => label(g, i)).join(','));
  check('opens with the over-claim catch on C1',
    r.steps[0]?.technique === 'over-claim' && label(g, r.steps[0].cell) === 'C1');
  check('the second move is trust propagation',
    r.steps[1]?.technique === 'trust-propagation');
  check('no stuck reason when solvable', r.reason === null);
  check('difficulty is set', r.difficulty !== null);
}

// ------------------------------------------------- direct-contradiction catches

section('Over-claim and under-claim are caught with no assumptions');
{
  // C1 claims 3 with only one buried mine possible in its pocket.
  const over = puzzleFromGrid(
    [
      ['X', 1, 0],
      [1, 2, 1],
      [3, 1, 0],
    ],
    1,
    1
  );
  const g = getGeometry(3, 3);
  const ro = grade(over);
  check('over-claimer flagged first, before any honest assumption',
    ro.steps[0]?.technique === 'over-claim' && label(g, ro.steps[0].cell) === 'C1');
  check('over-claim board still fully solves', ro.solvable && ro.minesComplete);

  // B1 sits next to two craters (A1, A2) but claims only 1. Every other cell's
  // claim clears its own crater count, so B1 is the first contradiction found.
  const under = puzzleFromGrid(
    [
      ['X', 'X', 1],
      [1, 2, 1],
      [0, 0, 0],
    ],
    1,
    1
  );
  const ru = grade(under);
  check('under-claimer flagged as a liar',
    ru.steps[0]?.technique === 'under-claim' && label(g, ru.steps[0].cell) === 'B1',
    `${ru.steps[0]?.technique} @ ${ru.steps[0] ? label(g, ru.steps[0].cell) : '-'}`);
}

// ------------------------------------------- determinism

section('Grading is deterministic');
{
  const rng = seededRng(4242);
  const gc = generate({ ...TIERS.junior, rng });
  if (!gc) {
    check('generated a junior case', false);
  } else {
    const a = grade(gc.puzzle);
    const b = grade(gc.puzzle);
    check('same solvable verdict', a.solvable === b.solvable);
    check('same liar set', a.liarsFound.join(',') === b.liarsFound.join(','));
    check('same step count', a.steps.length === b.steps.length);
    check('same difficulty', a.difficulty === b.difficulty);
  }
}

// ------------------------------------ soundness against the planted solution

section('Sound: a human solve never contradicts the hidden answer');
{
  const tiers: TierName[] = ['tutorial', 'junior', 'senior', 'fraudUnit'];
  let graded = 0;
  let solvable = 0;
  let unsound = 0;
  let liarDisagree = 0;
  let mineDisagree = 0;
  let unsolvedButUnique = 0;

  for (const tier of tiers) {
    const rng = seededRng(31337 + tier.length);
    for (let i = 0; i < 25; i++) {
      const gc = generate({ ...TIERS[tier], rng });
      if (!gc) continue;
      graded++;

      const r = grade(gc.puzzle);
      const truth = deriveLiars(gc.puzzle, gc.solution.mines).slice().sort((a, b) => a - b);
      const truthMines = gc.solution.mines.slice().sort((a, b) => a - b);

      // Every liar the grader names must really be a liar, solved or not.
      if (!r.liarsFound.every((c) => truth.includes(c))) unsound++;

      if (r.solvable) {
        solvable++;
        if (r.liarsFound.join(',') !== truth.join(',')) liarDisagree++;
        if (r.minesComplete && r.minesFound.join(',') !== truthMines.join(',')) mineDisagree++;
      } else {
        // A rejected puzzle is still a legitimate (uniquely solvable) puzzle —
        // the grader is an extra filter, not a replacement for uniqueness.
        check(`${tier} #${i}: unsolved case reports a reason`,
          typeof r.reason === 'string' && r.reason.length > 0 && r.difficulty === null,
          '');
        if (solve(gc.puzzle, { limit: 2 }).solutions.length === 1) unsolvedButUnique++;
      }
    }
  }

  check(`graded ${graded} generated puzzles`, graded > 50);
  check('at least some were human-solvable', solvable > 0, `${solvable}`);
  check('never named an innocent claim as a liar', unsound === 0, `${unsound} unsound`);
  check('solved liar sets match the planted liars exactly', liarDisagree === 0, `${liarDisagree}`);
  check('completed mine placements match the planted mines', mineDisagree === 0, `${mineDisagree}`);
  check('rejected puzzles were still uniquely solvable', unsolvedButUnique > 0);
}

// -------------------------------------- generator integration

section('generate({ requireHumanSolvable: true })');
{
  for (const tier of ['tutorial', 'junior', 'senior'] as TierName[]) {
    const rng = seededRng(9001);
    const tel = emptyTelemetry();
    const gc = generate({ ...TIERS[tier], rng, requireHumanSolvable: true, maxAttempts: 4000 }, tel);

    if (!gc) {
      check(`${tier}: produced a human-solvable case`, false, 'returned null');
      continue;
    }
    check(`${tier}: the returned puzzle passes the grader`, grade(gc.puzzle).solvable);
    check(`${tier}: still uniquely solvable`, solve(gc.puzzle, { limit: 2 }).solutions.length === 1);
    check(`${tier}: grader was actually consulted`, tel.gradeCalls >= 1);
    check(`${tier}: rejection counter is coherent`,
      tel.rejectedNotHumanSolvable >= 0 && tel.rejectedNotHumanSolvable < tel.attempts + 1);
  }

  // Off by default: a bare generate() never calls the grader.
  const tel = emptyTelemetry();
  generate({ ...TIERS.senior, rng: seededRng(5), maxAttempts: 50 }, tel);
  check('grader is not run unless asked', tel.gradeCalls === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
