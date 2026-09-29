import { getGeometry, computeCounts } from './board.ts';
import { CRATER, type Puzzle } from './types.ts';

export interface SolveOptions {
  /**
   * Stop as soon as this many solutions are found. Generation only needs to
   * know "is it exactly 1?", so it passes 2. Default: Infinity.
   */
  limit?: number;
}

export interface SolveResult {
  /** Each entry is a sorted array of buried-mine indices. */
  solutions: number[][];
  /** Candidate placements examined. Useful for profiling difficulty. */
  nodesVisited: number;
  /** True if the search stopped early because `limit` was reached. */
  truncated: boolean;
}

/**
 * Find every buried-mine placement consistent with the filed claims.
 *
 * THE KEY INSIGHT: the liar set is not searched independently. It is fully
 * determined by the mine placement —
 *
 *     liar_set(H) = { cell : claim[cell] !== trueCount(cell, H) }
 *
 * so a placement H is a valid solution iff |liar_set(H)| === liarCount.
 * That collapses a double enumeration into a single walk over placements.
 *
 * Implementation is a DFS placing mines at strictly increasing flat indices,
 * maintaining a live adjacency count array. A cell is "settled" once the
 * placement frontier passes its highest-indexed neighbour: no future mine can
 * touch it, so its claim can be checked and the running violation count
 * updated. Once violations exceed liarCount, the whole subtree is pruned.
 */
export function solve(puzzle: Puzzle, options: SolveOptions = {}): SolveResult {
  const limit = options.limit ?? Infinity;
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const { size, neighbours, lastNeighbour } = geometry;
  const { claims, mineCount, liarCount } = puzzle;

  const isCrater = new Uint8Array(size);
  for (const c of puzzle.craters) isCrater[c] = 1;

  // Live adjacency counts. Seeded with the craters, which never move.
  const counts = computeCounts(geometry, puzzle.craters);

  // Cells are settled in order of when their last neighbour is passed.
  // lastNeighbour is not monotonic in flat index (bottom row is a special
  // case), so sort explicitly rather than assuming.
  const settleOrder: number[] = [];
  for (let idx = 0; idx < size; idx++) {
    if (!isCrater[idx]) settleOrder.push(idx);
  }
  settleOrder.sort((a, b) => lastNeighbour[a] - lastNeighbour[b]);

  const solutions: number[][] = [];
  const stack: number[] = [];
  let nodesVisited = 0;
  let truncated = false;

  function place(idx: number, delta: number): void {
    const adj = neighbours[idx];
    for (let i = 0; i < adj.length; i++) counts[adj[i]] += delta;
  }

  function dfs(start: number, minesLeft: number, violations: number, settlePtr: number): void {
    if (solutions.length >= limit) {
      truncated = true;
      return;
    }

    // Settle every cell whose neighbourhood is now fully determined.
    let ptr = settlePtr;
    let viol = violations;
    while (ptr < settleOrder.length && lastNeighbour[settleOrder[ptr]] < start) {
      const cell = settleOrder[ptr];
      if (counts[cell] !== claims[cell]) {
        viol++;
        if (viol > liarCount) return; // prune: too many liars already
      }
      ptr++;
    }

    if (minesLeft === 0) {
      // Settle the remainder; nothing left to place can change any count.
      for (let k = ptr; k < settleOrder.length; k++) {
        const cell = settleOrder[k];
        if (counts[cell] !== claims[cell]) {
          viol++;
          if (viol > liarCount) return;
        }
      }
      nodesVisited++;
      if (viol === liarCount) solutions.push(stack.slice().sort((a, b) => a - b));
      return;
    }

    // Not enough cells remain to place the outstanding mines.
    for (let idx = start; idx <= size - minesLeft; idx++) {
      if (isCrater[idx]) continue;
      place(idx, +1);
      stack.push(idx);
      dfs(idx + 1, minesLeft - 1, viol, ptr);
      stack.pop();
      place(idx, -1);
      if (solutions.length >= limit) {
        truncated = true;
        return;
      }
    }
  }

  dfs(0, mineCount, 0, 0);
  return { solutions, nodesVisited, truncated };
}

/** Convenience: does this puzzle have exactly one solution? */
export function hasUniqueSolution(puzzle: Puzzle): boolean {
  return solve(puzzle, { limit: 2 }).solutions.length === 1;
}

/**
 * Given a mine placement, derive which cells must have lied.
 * Used to report the solution and to verify generator output.
 */
export function deriveLiars(puzzle: Puzzle, mines: readonly number[]): number[] {
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const counts = computeCounts(geometry, [...puzzle.craters, ...mines]);
  const liars: number[] = [];
  for (let idx = 0; idx < geometry.size; idx++) {
    if (puzzle.claims[idx] === CRATER) continue;
    if (counts[idx] !== puzzle.claims[idx]) liars.push(idx);
  }
  return liars;
}

/**
 * Reference implementation: exhaustive combination enumeration with no
 * pruning. Exponentially slower — used only to validate `solve` in tests.
 */
export function solveBruteForce(puzzle: Puzzle): number[][] {
  const geometry = getGeometry(puzzle.width, puzzle.height);
  const craterSet = new Set(puzzle.craters);
  const candidates: number[] = [];
  for (let i = 0; i < geometry.size; i++) if (!craterSet.has(i)) candidates.push(i);

  const out: number[][] = [];
  const combo: number[] = [];

  function recurse(start: number): void {
    if (combo.length === puzzle.mineCount) {
      const mines = combo.slice();
      if (deriveLiars(puzzle, mines).length === puzzle.liarCount) out.push(mines);
      return;
    }
    for (let i = start; i < candidates.length; i++) {
      combo.push(candidates[i]);
      recurse(i + 1);
      combo.pop();
    }
  }

  recurse(0);
  return out;
}
