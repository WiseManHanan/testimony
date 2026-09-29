import { getGeometry, label } from './core/board.ts';
import { deriveLiars } from './core/solver.ts';
import { generateTier, puzzleFromGrid, TIERS, type TierName } from './core/generator.ts';
import { CRATER, type GeneratedCase } from './core/types.ts';
import { soundtrack } from './audio/soundtrack.ts';
import {
  NoteHistory,
  approveRemaining,
  autoClearRemaining,
  canSubmit,
  cellsWithVerdict,
  clearAll,
  cycleOrdnance,
  cycleVerdict,
  review,
  tally,
  type Conflict,
} from './game/annotations.ts';

/**
 * Working UI, not the case-file presentation (DESIGN.md §7). The MARK MODEL
 * here is real and should carry forward. The styling should not.
 */

const TUTORIAL: GeneratedCase = {
  puzzle: puzzleFromGrid(
    [
      ['X', 2, 1],
      [1, 2, 0],
      [2, 1, 1],
    ],
    1,
    1
  ),
  solution: { mines: [5], liars: [6] },
};

type Tool = 'verdict' | 'ordnance';

/**
 * Tiers we ask the human-technique grader (core/grader.ts) to vet before
 * serving a case, so the player is never handed a puzzle that only yields to
 * guessing. Kept to the cheap tiers: fraudUnit and internalAffairs as tuned
 * today almost never produce a human-solvable board, so requiring it there
 * would spin for seconds or fail outright — they wait on the M/L retune
 * (DESIGN.md §8 step 5).
 */
const HUMAN_SOLVABLE_TIERS = new Set<TierName>(['junior', 'senior']);

let current: GeneratedCase = TUTORIAL;
let currentTier: TierName | 'tutorial' = 'tutorial';
const history = new NoteHistory(TUTORIAL.puzzle.width * TUTORIAL.puzzle.height);
let tool: Tool = 'verdict';
let showWorking = false;
let revealed = false;
let audioOn = false;

const app = document.getElementById('app')!;

const VERDICT_GLYPH: Record<string, string> = {
  none: '',
  approved: '\u2713',
  questionable: '?',
  fraud: '\u2715',
};

/**
 * Classic Minesweeper vocabulary: a flag asserts a mine, a question mark is a
 * maybe, and "cleared" has no glyph at all — the sunken bevel says it, exactly
 * as an opened cell does in the original.
 */
const ORDNANCE_GLYPH: Record<string, string> = {
  none: '',
  clear: '',
  mine: '\u2691',   // flag
  maybe: '?',
};

const ORDNANCE_TITLE: Record<string, string> = {
  none: '',
  clear: 'No mine here — certain',
  mine: 'Mine here — certain',
  maybe: 'Possible mine — not committed',
};

function newCase(tier: TierName | 'tutorial'): void {
  if (tier === 'tutorial') {
    current = TUTORIAL;
  } else {
    const humanSolvable = HUMAN_SOLVABLE_TIERS.has(tier);
    const generated = generateTier(
      tier,
      undefined,
      humanSolvable ? { requireHumanSolvable: true, maxAttempts: 6000 } : {}
    );
    if (!generated) {
      alert(`Could not generate a ${tier} case. Try again or loosen the tier config.`);
      render(); // keep the layout dropdown in sync with the case still in play
      return;
    }
    current = generated;
  }
  currentTier = tier;
  history.reset(current.puzzle.width * current.puzzle.height);
  revealed = false;
  render();
}

function applyToCell(idx: number, useOrdnance: boolean): void {
  if (revealed) return;
  if (current.puzzle.claims[idx] === CRATER) return;

  history.apply((draft) => {
    const note = draft.cells[idx];
    if (useOrdnance) note.ordnance = cycleOrdnance(note.ordnance);
    else note.verdict = cycleVerdict(note.verdict);
  });
  soundtrack.sfx('stamp');
  render();
}

function renderCell(idx: number, conflictMap: Map<number, Conflict>): string {
  const { puzzle, solution } = current;
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const note = history.current.cells[idx];
  const isCrater = puzzle.claims[idx] === CRATER;

  const classes = ['cell'];
  if (isCrater) classes.push('crater');
  else {
    classes.push(`v-${note.verdict}`);
    classes.push(`o-${note.ordnance}`);
  }

  const conflict = conflictMap.get(idx);
  if (showWorking && conflict) classes.push(`conflict-${conflict.kind}`);
  if (showWorking && conflict?.disputesOwnApproval) classes.push('self-contradiction');

  if (revealed) {
    const trueLiars = new Set(deriveLiars(puzzle, solution.mines));
    if (trueLiars.has(idx)) classes.push('was-liar');
    if (new Set(solution.mines).has(idx)) classes.push('was-mine');
  }

  const claimText = isCrater
    ? `<span class="claim">\u2739</span>`
    : `<span class="claim c${puzzle.claims[idx]}">${puzzle.claims[idx]}</span>`;

  const verdictIcon = note.verdict !== 'none' && !isCrater
    ? `<span class="verdict-icon">${VERDICT_GLYPH[note.verdict]}</span>`
    : '';

  const ordnanceIcon = note.ordnance !== 'none' && !isCrater
    ? `<span class="ordnance-icon" title="${ORDNANCE_TITLE[note.ordnance]}">${ORDNANCE_GLYPH[note.ordnance]}</span>`
    : '';

  const working = showWorking && !isCrater && conflict
    ? `<span class="working">${conflict.marked}/${puzzle.claims[idx]}</span>`
    : '';

  return `<button class="${classes.join(' ')}" data-idx="${idx}" ${isCrater ? 'disabled' : ''}
    aria-label="${label(geometry, idx)}, claim ${isCrater ? 'crater' : puzzle.claims[idx]}, verdict ${note.verdict}, ordnance ${note.ordnance}">
    ${claimText}${verdictIcon}${ordnanceIcon}${working}
  </button>`;
}

function render(): void {
  const { puzzle, solution } = current;
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const notes = history.current;
  const t = tally(puzzle, notes);
  const r = review(puzzle, notes);
  const conflictMap = new Map(r.conflicts.map((c) => [c.cell, c]));

  const cells: string[] = [];
  for (let idx = 0; idx < geometry.size; idx++) cells.push(renderCell(idx, conflictMap));

  const trueLiars = new Set(deriveLiars(puzzle, solution.mines));
  const accused = cellsWithVerdict(notes, 'fraud');
  const correct = accused.length === trueLiars.size && accused.every((i) => trueLiars.has(i));
  const selfContradictions = r.conflicts.filter((c) => c.disputesOwnApproval).length;

  const pad = (n: number) => String(Math.max(0, Math.min(999, n))).padStart(3, '0');
  const remainingFraud = puzzle.liarCount - t.fraud;
  const remainingMines = puzzle.mineCount - t.mines;
  const face = revealed ? (correct ? '\u2713' : '\u2717') : '\u25a3';

  app.innerHTML = `
    <div class="titlebar">
      <span>Testimony &mdash; Case 0412</span>
      <span class="tb-buttons">
        <span class="tb-btn">_</span><span class="tb-btn">\u25a1</span><span class="tb-btn">\u2715</span>
      </span>
    </div>
    <div class="menubar">
      <span>Case</span><span>Marks</span>
      <span id="sound">Sound: ${audioOn ? 'on' : 'off'}</span>
      <span>Help</span>
    </div>

    <div class="frame">
      <div class="statusbar">
        <div class="led-group">
          <div class="led ${remainingFraud < 0 ? 'spent' : ''}">${pad(remainingFraud)}</div>
          <div class="led-label">FRAUD</div>
        </div>
        <button class="facebtn" id="face" title="New case">${face}</button>
        <div class="led-group">
          <div class="led ${remainingMines < 0 ? 'spent' : ''}">${pad(remainingMines)}</div>
          <div class="led-label">ORDNANCE</div>
        </div>
      </div>

    <header>
      <div class="budgets">
        <span class="chip chip-fraud ${r.overFraudBudget ? 'over' : ''}">
          <b>${t.fraud}</b>/${puzzle.liarCount} fraud
        </span>
        <span class="chip chip-mine ${r.overMineBudget ? 'over' : ''}">
          <b>${t.mines}</b>/${puzzle.mineCount} ordnance
        </span>
        <span class="chip chip-approved"><b>${t.approved}</b> approved</span>
        <span class="chip chip-question"><b>${t.questionable}</b> questioned</span>
        <span class="chip chip-plain"><b>${t.untouched}</b> untouched</span>
      </div>
    </header>

    <div class="toolbar">
      <span class="toolbar-label">Left-click applies:</span>
      <button class="tool ${tool === 'verdict' ? 'on' : ''}" data-tool="verdict">
        Verdict &nbsp;<span class="mini v">\u2713 ? \u2715</span>
      </button>
      <button class="tool ${tool === 'ordnance' ? 'on' : ''}" data-tool="ordnance">
        Ordnance &nbsp;<span class="mini o">flag / ? / clear</span>
      </button>
      <button class="toggle ${showWorking ? 'on' : ''}" id="working">Show working</button>
    </div>

    <div class="board" style="grid-template-columns: repeat(${puzzle.width}, var(--cell))">${cells.join('')}</div>

    ${
      showWorking && r.conflicts.length > 0
        ? `<p class="hint">
             <b>${r.conflicts.length}</b> claim${r.conflicts.length === 1 ? '' : 's'} can't be satisfied by your ordnance marks.
             Either a mark is wrong, or that claimant is lying.
             ${selfContradictions > 0 ? `<br><span class="warn">${selfContradictions} of them you also approved.</span>` : ''}
           </p>`
        : ''
    }
    ${
      revealed
        ? correct
          ? `<p class="verdict-line ok">Case closed. Fraud identified. Payouts issued.</p>`
          : `<p class="verdict-line bad">Determination rejected. The fraud stands.</p>`
        : ''
    }
    ${
      revealed
        ? `<p class="report">Ordnance: ${solution.mines.map((m) => label(geometry, m)).join(', ') || 'none'}.
           Fraudulent claims: ${[...trueLiars].map((l) => label(geometry, l)).join(', ') || 'none'}.</p>`
        : ''
    }

    <div class="controls">
      <button id="undo" ${history.canUndo ? '' : 'disabled'}>Undo</button>
      <button id="redo" ${history.canRedo ? '' : 'disabled'}>Redo</button>
      <button id="autoclear" ${t.mines === puzzle.mineCount ? '' : 'disabled'}>Clear rest</button>
      <button id="approverest">Approve rest</button>
      <button id="clearboard" class="danger" ${t.untouched === geometry.size - puzzle.craters.length ? 'disabled' : ''}>Clear board</button>
    </div>

    <div class="controls">
      <button id="submit" class="primary" ${canSubmit(puzzle, notes) && !revealed ? '' : 'disabled'}>
        Submit determination
      </button>
      <select id="tier" title="Board layout in play">
        ${Object.keys(TIERS)
          .map((k) => {
            const t = TIERS[k as TierName];
            return `<option value="${k}" ${currentTier === k ? 'selected' : ''}>${k} (${t.width}x${t.height})</option>`;
          })
          .join('')}
      </select>
      <button id="new">New case</button>
    </div>

    <div class="legend">
      <div class="legend-group">
        <span class="legend-title">Verdict &mdash; is this testimony honest?</span>
        <span class="key k-approved">\u2713 approved</span>
        <span class="key k-question">? questionable</span>
        <span class="key k-fraud">\u2715 fraud</span>
      </div>
      <div class="legend-group">
        <span class="legend-title">Ordnance &mdash; is a mine buried here? (right-click cycles)</span>
        <span class="key k-clear">sunken = no mine, certain</span>
        <span class="key k-mine">\u2691 mine &mdash; certain</span>
        <span class="key k-maybe">? possible mine</span>
      </div>
      <p class="legend-note">
        Left-click cycles the active tool. <b>Right-click always cycles ordnance.</b>
        The two are independent &mdash; a tile can be honest and still be sitting on a mine.
        <br>First right-click marks a cell <b>&#8856; no mine</b>, since that is the
        commonest call. Click again for mine, again for possible.
        Keys: 1 / 2 tools, W working, Cmd+Z undo. Clear board is undoable.
      </p>
    </div>
    </div>
  `;

  app.querySelectorAll<HTMLButtonElement>('.cell').forEach((el) => {
    const idx = Number(el.dataset.idx);
    el.addEventListener('click', () => applyToCell(idx, tool === 'ordnance'));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      applyToCell(idx, true);
    });
  });

  app.querySelectorAll<HTMLButtonElement>('.tool').forEach((el) => {
    el.addEventListener('click', () => {
      tool = el.dataset.tool as Tool;
      render();
    });
  });

  app.querySelector('#working')!.addEventListener('click', () => {
    showWorking = !showWorking;
    render();
  });
  app.querySelector('#undo')!.addEventListener('click', () => {
    history.undo();
    render();
  });
  app.querySelector('#redo')!.addEventListener('click', () => {
    history.redo();
    render();
  });
  app.querySelector('#autoclear')!.addEventListener('click', () => {
    history.apply((draft) => autoClearRemaining(puzzle, draft));
    render();
  });
  app.querySelector('#approverest')!.addEventListener('click', () => {
    history.apply((draft) => approveRemaining(puzzle, draft));
    render();
  });
  app.querySelector('#clearboard')!.addEventListener('click', () => {
    // Routed through history so a mis-click is recoverable with undo.
    history.apply(clearAll);
    render();
  });
  app.querySelector('#submit')!.addEventListener('click', () => {
    revealed = true;
    // The music is deliberately untouched here. On a wrong determination it
    // keeps playing exactly as before — that indifference is the joke.
    soundtrack.sfx('reveal');
    const rightCall = cellsWithVerdict(history.current, 'fraud')
      .every((i) => trueLiars.has(i)) && cellsWithVerdict(history.current, 'fraud').length === trueLiars.size;
    if (rightCall) {
      soundtrack.duck(1.4);
      window.setTimeout(() => soundtrack.sfx('correct'), 320);
    }
    render();
  });
  app.querySelector('#sound')!.addEventListener('click', async () => {
    audioOn = !audioOn;
    if (audioOn) await soundtrack.start();
    else soundtrack.stop();
    render();
  });
  app.querySelector('#tier')!.addEventListener('change', (e) => {
    newCase((e.target as HTMLSelectElement).value as TierName | 'tutorial');
  });
  app.querySelector('#new')!.addEventListener('click', () => {
    const tier = (app.querySelector('#tier') as HTMLSelectElement).value;
    newCase(tier as TierName | 'tutorial');
  });
  app.querySelector('#face')!.addEventListener('click', () => {
    const tier = (app.querySelector('#tier') as HTMLSelectElement).value;
    newCase(tier as TierName | 'tutorial');
  });
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;

  if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.shiftKey) history.redo();
    else history.undo();
    render();
    return;
  }
  if (e.key === '1') { tool = 'verdict'; render(); }
  if (e.key === '2') { tool = 'ordnance'; render(); }
  if (e.key.toLowerCase() === 'w') { showWorking = !showWorking; render(); }
});

render();
