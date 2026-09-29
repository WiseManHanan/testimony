import { getGeometry } from '../core/board.ts';
import { CRATER, type Puzzle } from '../core/types.ts';

/**
 * Player annotations.
 *
 * TWO INDEPENDENT AXES. Never collapse them into one mark cycle.
 *
 *   Verdict  — what you think of this tile's TESTIMONY (is it lying?)
 *   Ordnance — what you think is UNDER this tile (is there a mine?)
 *
 * The tutorial board is the proof they must stay separate: B3 is a mine AND
 * honest; C1 is clean AND a liar. One axis cannot express that.
 */

/** Verdict on a tile's filed claim. Cycles in this order on click. */
export type Verdict = 'none' | 'approved' | 'questionable' | 'fraud';

/**
 * Belief about buried ordnance under a tile.
 *
 *   clear — no mine here, certain. Proven by deduction.
 *   mine  — a mine is here, certain.
 *   maybe — a candidate. Counts as OPEN in review(), never as a mine.
 */
export type Ordnance = 'none' | 'clear' | 'mine' | 'maybe';

export const VERDICT_CYCLE: Verdict[] = ['none', 'approved', 'questionable', 'fraud'];

/**
 * `clear` comes FIRST deliberately. On any board, most cells are safe — a
 * senior-tier 6x6 has 3 mines and 33 other cells. Ruling a cell out is the
 * commonest action a player takes, so it must be one click, not three.
 * Minesweeper puts the flag first because there you never mark safety
 * explicitly; here you do, constantly.
 */
export const ORDNANCE_CYCLE: Ordnance[] = ['none', 'clear', 'mine', 'maybe'];

export interface CellNote {
  verdict: Verdict;
  ordnance: Ordnance;
}

export interface Notes {
  cells: CellNote[];
}

export function emptyNote(): CellNote {
  return { verdict: 'none', ordnance: 'none' };
}

export function emptyNotes(size: number): Notes {
  return { cells: Array.from({ length: size }, emptyNote) };
}

function cloneNotes(notes: Notes): Notes {
  return { cells: notes.cells.map((c) => ({ ...c })) };
}

function next<T>(cycle: T[], value: T): T {
  return cycle[(cycle.indexOf(value) + 1) % cycle.length];
}

export function cycleVerdict(v: Verdict): Verdict {
  return next(VERDICT_CYCLE, v);
}

export function cycleOrdnance(o: Ordnance): Ordnance {
  return next(ORDNANCE_CYCLE, o);
}

// ------------------------------------------------------------------ history

export class NoteHistory {
  private past: Notes[] = [];
  private future: Notes[] = [];
  private present: Notes;

  constructor(size: number) {
    this.present = emptyNotes(size);
  }

  get current(): Notes {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  apply(mutate: (draft: Notes) => void): void {
    const draft = cloneNotes(this.present);
    mutate(draft);
    this.past.push(this.present);
    this.present = draft;
    this.future = [];
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.present);
    this.present = previous;
  }

  redo(): void {
    const nextState = this.future.pop();
    if (!nextState) return;
    this.past.push(this.present);
    this.present = nextState;
  }

  reset(size: number): void {
    this.past = [];
    this.future = [];
    this.present = emptyNotes(size);
  }
}

// ------------------------------------------------------------------ tallies

export interface Tally {
  approved: number;
  questionable: number;
  fraud: number;
  mines: number;
  maybeMines: number;
  cleared: number;
  /** Non-crater cells carrying no mark on either axis. */
  untouched: number;
}

export function tally(puzzle: Puzzle, notes: Notes): Tally {
  const t: Tally = {
    approved: 0,
    questionable: 0,
    fraud: 0,
    mines: 0,
    maybeMines: 0,
    cleared: 0,
    untouched: 0,
  };

  for (let idx = 0; idx < notes.cells.length; idx++) {
    if (puzzle.claims[idx] === CRATER) continue;
    const { verdict, ordnance } = notes.cells[idx];

    if (verdict === 'approved') t.approved++;
    else if (verdict === 'questionable') t.questionable++;
    else if (verdict === 'fraud') t.fraud++;

    if (ordnance === 'mine') t.mines++;
    else if (ordnance === 'maybe') t.maybeMines++;
    else if (ordnance === 'clear') t.cleared++;

    if (verdict === 'none' && ordnance === 'none') t.untouched++;
  }

  return t;
}

// ------------------------------------------------------- consistency review

export type ConflictKind = 'over' | 'under';

export interface Conflict {
  cell: number;
  kind: ConflictKind;
  /** Mines firmly marked adjacent to this cell, craters included. */
  marked: number;
  /** Adjacent cells still open — unmarked or marked "maybe". */
  open: number;
  /** True if the player also approved this claim, contradicting themselves. */
  disputesOwnApproval: boolean;
}

export interface Review {
  /**
   * Claims that cannot be satisfied by the player's current ordnance marks.
   *   over  — more mines marked adjacent than the claim allows
   *   under — not enough open cells remain to reach the claim
   *
   * A conflict is NOT proof the tile lied. It means either a mark is wrong or
   * that claimant is lying. That ambiguity is the game.
   */
  conflicts: Conflict[];
  overMineBudget: boolean;
  overFraudBudget: boolean;
}

/**
 * Check the player's marks against the visible claims.
 *
 * BOOKKEEPING ONLY. Never consults the hidden solution. This is the arithmetic
 * a player would do on paper, minus the slips. Do not extend this into a hint
 * system backed by the real solver — every accusation must stay provable.
 *
 * "maybe" ordnance counts as open, not as a mine, so pencilled-in guesses
 * widen the possibility space rather than asserting anything.
 */
export function review(puzzle: Puzzle, notes: Notes): Review {
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const craterSet = new Set(puzzle.craters);
  const conflicts: Conflict[] = [];

  for (let idx = 0; idx < geometry.size; idx++) {
    if (puzzle.claims[idx] === CRATER) continue;

    let marked = 0;
    let open = 0;

    for (const n of geometry.neighbours[idx]) {
      if (craterSet.has(n)) {
        marked++;
        continue;
      }
      const o = notes.cells[n].ordnance;
      if (o === 'mine') marked++;
      else if (o === 'none' || o === 'maybe') open++;
    }

    const claim = puzzle.claims[idx];
    const approved = notes.cells[idx].verdict === 'approved';

    if (marked > claim) {
      conflicts.push({ cell: idx, kind: 'over', marked, open, disputesOwnApproval: approved });
    } else if (marked + open < claim) {
      conflicts.push({ cell: idx, kind: 'under', marked, open, disputesOwnApproval: approved });
    }
  }

  const t = tally(puzzle, notes);
  return {
    conflicts,
    overMineBudget: t.mines > puzzle.mineCount,
    overFraudBudget: t.fraud > puzzle.liarCount,
  };
}

/**
 * Once `mineCount` mines are firmly marked, every remaining open cell must be
 * clear. Saves a lot of clicking. "maybe" marks are resolved to clear too.
 */
export function autoClearRemaining(puzzle: Puzzle, notes: Notes): void {
  if (tally(puzzle, notes).mines !== puzzle.mineCount) return;
  for (let idx = 0; idx < notes.cells.length; idx++) {
    if (puzzle.claims[idx] === CRATER) continue;
    const note = notes.cells[idx];
    if (note.ordnance === 'none' || note.ordnance === 'maybe') note.ordnance = 'clear';
  }
}

/**
 * Approve every claim not already marked fraud or questionable. Useful once
 * the player has settled the board and only wants to flag the exceptions.
 */
export function approveRemaining(puzzle: Puzzle, notes: Notes): void {
  for (let idx = 0; idx < notes.cells.length; idx++) {
    if (puzzle.claims[idx] === CRATER) continue;
    if (notes.cells[idx].verdict === 'none') notes.cells[idx].verdict = 'approved';
  }
}

/**
 * Wipe every mark on the board. Routed through `NoteHistory.apply` by the UI,
 * so a full clear is itself undoable — the player never loses work to a
 * mis-click on the reset button.
 */
export function clearAll(notes: Notes): void {
  for (const note of notes.cells) {
    note.verdict = 'none';
    note.ordnance = 'none';
  }
}

/** Ready to submit: exactly `liarCount` fraud verdicts filed. */
export function canSubmit(puzzle: Puzzle, notes: Notes): boolean {
  return tally(puzzle, notes).fraud === puzzle.liarCount;
}

/** Indices carrying a given verdict, in board order. */
export function cellsWithVerdict(notes: Notes, verdict: Verdict): number[] {
  const out: number[] = [];
  for (let i = 0; i < notes.cells.length; i++) {
    if (notes.cells[i].verdict === verdict) out.push(i);
  }
  return out;
}
