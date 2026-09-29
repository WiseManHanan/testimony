import { parseLabel, getGeometry } from '../core/board.ts';
import { puzzleFromGrid } from '../core/generator.ts';
import {
  NoteHistory,
  approveRemaining,
  autoClearRemaining,
  canSubmit,
  cellsWithVerdict,
  clearAll,
  cycleOrdnance,
  cycleVerdict,
  emptyNotes,
  review,
  tally,
} from './annotations.ts';

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

const puzzle = puzzleFromGrid(
  [
    ['X', 2, 1],
    [1, 2, 0],
    [2, 1, 1],
  ],
  1,
  1
);
const geometry = getGeometry(3, 3);
const at = (name: string) => parseLabel(geometry, name);

console.log('\nMark cycles');
{
  check('verdict: none -> approved', cycleVerdict('none') === 'approved');
  check('verdict: approved -> questionable', cycleVerdict('approved') === 'questionable');
  check('verdict: questionable -> fraud', cycleVerdict('questionable') === 'fraud');
  check('verdict: fraud wraps to none', cycleVerdict('fraud') === 'none');

  // "clear" is first: ruling a cell out is the commonest action, so it must
  // be reachable in one click. See ORDNANCE_CYCLE for the reasoning.
  check('ordnance: none -> clear (one click to rule out)', cycleOrdnance('none') === 'clear');
  check('ordnance: clear -> mine', cycleOrdnance('clear') === 'mine');
  check('ordnance: mine -> maybe', cycleOrdnance('mine') === 'maybe');
  check('ordnance: maybe wraps to none', cycleOrdnance('maybe') === 'none');
}

console.log('\nAxes stay independent');
{
  const notes = emptyNotes(9);
  notes.cells[at('B3')].ordnance = 'mine';
  notes.cells[at('B3')].verdict = 'approved';
  notes.cells[at('C1')].verdict = 'fraud';

  const t = tally(puzzle, notes);
  check('a tile can be a mine AND approved', t.mines === 1 && t.approved === 1);
  check('accusing C1 does not mark it a mine', notes.cells[at('C1')].ordnance === 'none');
  check('fraud tally is independent of ordnance', t.fraud === 1);
}

console.log('\nQuestionable marks');
{
  const notes = emptyNotes(9);
  notes.cells[at('A2')].verdict = 'questionable';
  notes.cells[at('C1')].verdict = 'fraud';

  const t = tally(puzzle, notes);
  check('questionable counted separately', t.questionable === 1 && t.fraud === 1);
  check('questionable does not block submit', canSubmit(puzzle, notes));
  check('cellsWithVerdict finds the accusation', cellsWithVerdict(notes, 'fraud').join() === String(at('C1')));
}

console.log('\nSubmit gate');
{
  const notes = emptyNotes(9);
  check('cannot submit with zero accusations', !canSubmit(puzzle, notes));
  notes.cells[at('C1')].verdict = 'fraud';
  check('can submit at exactly the liar budget', canSubmit(puzzle, notes));
  notes.cells[at('A2')].verdict = 'fraud';
  check('cannot submit over the liar budget', !canSubmit(puzzle, notes));
}

console.log('\nConsistency review');
{
  const notes = emptyNotes(9);
  notes.cells[at('B3')].ordnance = 'mine';
  autoClearRemaining(puzzle, notes);

  const r = review(puzzle, notes);
  const cells = r.conflicts.map((c) => c.cell);
  check(
    'C1 is the only conflict under the true solution',
    cells.length === 1 && cells[0] === at('C1'),
    `got ${cells.length}`
  );
  check('C1 conflict is an under-run', r.conflicts[0]?.kind === 'under');
  check('no budget overrun reported', !r.overMineBudget && !r.overFraudBudget);
}

console.log('\n"maybe" widens rather than asserts');
{
  const notes = emptyNotes(9);
  // Mark everything clear except one maybe — the claims should still be
  // satisfiable, so "maybe" must count as open, not as a mine.
  for (let i = 0; i < 9; i++) {
    if (puzzle.claims[i] !== -1) notes.cells[i].ordnance = 'clear';
  }
  notes.cells[at('B3')].ordnance = 'maybe';

  const r = review(puzzle, notes);
  check('maybe does not count toward the mine tally', tally(puzzle, notes).mines === 0);
  check('maybe keeps A3 satisfiable', !r.conflicts.some((c) => c.cell === at('A3')));
}

console.log('\nSelf-contradiction flag');
{
  const notes = emptyNotes(9);
  notes.cells[at('B3')].ordnance = 'mine';
  autoClearRemaining(puzzle, notes);
  notes.cells[at('C1')].verdict = 'approved';

  const r = review(puzzle, notes);
  const c1 = r.conflicts.find((c) => c.cell === at('C1'));
  check('approving an unsatisfiable claim is flagged', c1?.disputesOwnApproval === true);
}

console.log('\nBulk helpers');
{
  const notes = emptyNotes(9);
  notes.cells[at('B3')].ordnance = 'mine';
  autoClearRemaining(puzzle, notes);
  check('auto-clear resolves every open cell', tally(puzzle, notes).cleared === 7);

  const partial = emptyNotes(9);
  autoClearRemaining(puzzle, partial);
  check('auto-clear is a no-op below budget', tally(puzzle, partial).cleared === 0);

  const verdicts = emptyNotes(9);
  verdicts.cells[at('C1')].verdict = 'fraud';
  approveRemaining(puzzle, verdicts);
  const t = tally(puzzle, verdicts);
  check('approve-rest fills the unmarked', t.approved === 7 && t.fraud === 1);
}

console.log('\nUndo / redo');
{
  const history = new NoteHistory(9);
  check('nothing to undo initially', !history.canUndo && !history.canRedo);

  history.apply((d) => { d.cells[at('B3')].ordnance = 'mine'; });
  history.apply((d) => { d.cells[at('C1')].verdict = 'fraud'; });

  history.undo();
  check('undo reverts the accusation', history.current.cells[at('C1')].verdict === 'none');
  check('undo keeps the earlier ordnance mark', history.current.cells[at('B3')].ordnance === 'mine');

  history.redo();
  check('redo restores the accusation', history.current.cells[at('C1')].verdict === 'fraud');

  history.undo();
  history.apply((d) => { d.cells[at('A3')].ordnance = 'clear'; });
  check('a new action clears the redo stack', !history.canRedo);

  history.reset(9);
  check('reset wipes everything', !history.canUndo && tally(puzzle, history.current).untouched === 8);
}



console.log('\nClear board');
{
  const notes = emptyNotes(9);
  notes.cells[at('B3')].ordnance = 'mine';
  notes.cells[at('C1')].verdict = 'fraud';
  notes.cells[at('A2')].verdict = 'questionable';
  notes.cells[at('A3')].ordnance = 'clear';

  clearAll(notes);
  const t = tally(puzzle, notes);
  check(
    'every mark is wiped',
    t.fraud === 0 && t.approved === 0 && t.questionable === 0 && t.mines === 0 && t.cleared === 0
  );
  check('all non-crater cells read untouched', t.untouched === 8);
  check('craters are left alone', puzzle.claims[at('A1')] === -1);
}

console.log('\nClear board is undoable');
{
  const history = new NoteHistory(9);
  history.apply((d) => { d.cells[at('B3')].ordnance = 'mine'; });
  history.apply((d) => { d.cells[at('C1')].verdict = 'fraud'; });
  history.apply(clearAll);

  check('board is empty after clearing', tally(puzzle, history.current).untouched === 8);

  history.undo();
  check('undo restores the accusation', history.current.cells[at('C1')].verdict === 'fraud');
  check('undo restores the ordnance mark', history.current.cells[at('B3')].ordnance === 'mine');

  history.redo();
  check('redo clears it again', tally(puzzle, history.current).untouched === 8);
}


console.log('\nCertainty is distinguishable');
{
  const notes = emptyNotes(9);
  notes.cells[at('A2')].ordnance = 'clear';
  notes.cells[at('A3')].ordnance = 'maybe';

  const t = tally(puzzle, notes);
  check('clear and maybe tally separately', t.cleared === 1 && t.maybeMines === 1);
  check('neither counts toward the mine budget', t.mines === 0);

  // The distinction has teeth: a definite "no mine" removes a cell from the
  // possibility space, a "maybe" does not.
  const definite = emptyNotes(9);
  for (const n of ['A2', 'A3', 'B2', 'C2', 'C3', 'B1', 'C1']) {
    definite.cells[at(n)].ordnance = 'clear';
  }
  const rDefinite = review(puzzle, definite);
  check(
    'ruling out everything but B3 forces the mine there',
    rDefinite.conflicts.every((c) => c.cell === at('C1')),
    `unexpected conflicts: ${rDefinite.conflicts.length}`
  );

  const hedged = emptyNotes(9);
  for (const n of ['A2', 'A3', 'B2', 'C2', 'C3', 'B1', 'C1']) {
    hedged.cells[at(n)].ordnance = 'maybe';
  }
  const rHedged = review(puzzle, hedged);
  check(
    'hedging with maybe forces nothing',
    rHedged.conflicts.length === 0,
    `got ${rHedged.conflicts.length} conflicts`
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
