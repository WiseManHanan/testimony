/**
 * Testimony — core type definitions.
 *
 * Cells are addressed by a flat row-major index: `idx = row * width + col`.
 * Row-major ordering is load-bearing for the solver's pruning strategy
 * (see solver.ts), so do not reorder.
 */

/** A cell that is a confirmed, visible crater. Always a mine. Files no claim. */
export const CRATER = -1;

/** Static geometry of a board. Neighbour lists are precomputed once. */
export interface Geometry {
  width: number;
  height: number;
  size: number;
  /** neighbours[i] = flat indices of the up-to-8 cells adjacent to i. */
  neighbours: Int32Array[];
  /**
   * lastNeighbour[i] = the highest flat index among i's neighbours.
   * Once the solver's placement frontier passes this, cell i's adjacency
   * count can never change again, so its claim can be checked and finalised.
   */
  lastNeighbour: Int32Array;
}

/** A generated puzzle, as presented to the player. */
export interface Puzzle {
  width: number;
  height: number;
  /** Flat indices of visible craters. */
  craters: number[];
  /**
   * claims[i] = the number this cell filed, or CRATER if it is a crater.
   * Craters do not file claims.
   */
  claims: Int8Array;
  /** Number of buried (unconfirmed) mines the player is told about. */
  mineCount: number;
  /** Number of fraudulent claims the player is told about. */
  liarCount: number;
}

/** The hidden truth behind a puzzle. Never shown until the case is closed. */
export interface Solution {
  /** Flat indices of the buried mines. */
  mines: number[];
  /** Flat indices of the cells that filed fraudulent claims. */
  liars: number[];
}

export interface GeneratedCase {
  puzzle: Puzzle;
  solution: Solution;
}

export interface GeneratorConfig {
  width: number;
  height: number;
  /** How many mines are pre-exploded and visible. */
  craterCount: number;
  /** How many mines remain buried. */
  mineCount: number;
  /** How many cells file a fraudulent claim. */
  liarCount: number;
  /** Attempts before giving up. Default 2000. */
  maxAttempts?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /**
   * Also reject any puzzle the human-technique grader (grader.ts) cannot
   * solve without guessing — DESIGN.md §8 step 6. Off by default so the core
   * tests and any bare `generate()` call are unaffected; the game and the
   * tuning harness pass it explicitly.
   */
  requireHumanSolvable?: boolean;
}
