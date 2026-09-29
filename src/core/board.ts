import { CRATER, type Geometry } from './types.ts';

const geometryCache = new Map<string, Geometry>();

/**
 * Build (or retrieve) the static geometry for a board size.
 *
 * Neighbour lists and `lastNeighbour` are precomputed because the solver
 * touches them millions of times per generated puzzle.
 */
export function getGeometry(width: number, height: number): Geometry {
  const key = `${width}x${height}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const size = width * height;
  const neighbours: Int32Array[] = new Array(size);
  const lastNeighbour = new Int32Array(size);

  for (let idx = 0; idx < size; idx++) {
    const row = Math.floor(idx / width);
    const col = idx % width;
    const list: number[] = [];

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= height || c < 0 || c >= width) continue;
        list.push(r * width + c);
      }
    }

    neighbours[idx] = Int32Array.from(list);
    lastNeighbour[idx] = list.length > 0 ? Math.max(...list) : -1;
  }

  const geometry: Geometry = { width, height, size, neighbours, lastNeighbour };
  geometryCache.set(key, geometry);
  return geometry;
}

/**
 * Count mines adjacent to every cell, given a full mine set.
 * Returns a fresh Int8Array of length `size`.
 */
export function computeCounts(geometry: Geometry, mines: Iterable<number>): Int8Array {
  const counts = new Int8Array(geometry.size);
  for (const mine of mines) {
    const adj = geometry.neighbours[mine];
    for (let i = 0; i < adj.length; i++) counts[adj[i]]++;
  }
  return counts;
}

/**
 * Compute the truthful claim every non-crater cell would file.
 * Craters file nothing and are marked CRATER.
 *
 * Note: a cell sitting on a buried mine still files a claim about its
 * NEIGHBOURS. It does not report itself. This is deliberate — it produces
 * the "technically accurate, sitting on the bomb" moments.
 */
export function computeTruthfulClaims(
  geometry: Geometry,
  craters: readonly number[],
  mines: readonly number[]
): Int8Array {
  const counts = computeCounts(geometry, [...craters, ...mines]);
  const claims = new Int8Array(geometry.size);
  const craterSet = new Set(craters);

  for (let idx = 0; idx < geometry.size; idx++) {
    claims[idx] = craterSet.has(idx) ? CRATER : counts[idx];
  }
  return claims;
}

/** Cells that file claims, i.e. every non-crater cell, in row-major order. */
export function filingCells(geometry: Geometry, craters: readonly number[]): number[] {
  const craterSet = new Set(craters);
  const out: number[] = [];
  for (let idx = 0; idx < geometry.size; idx++) {
    if (!craterSet.has(idx)) out.push(idx);
  }
  return out;
}

/** Convert a flat index to a human-readable label: A1, B3, C2... */
export function label(geometry: Geometry, idx: number): string {
  const row = Math.floor(idx / geometry.width);
  const col = idx % geometry.width;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/** Parse a label back to a flat index. Throws on out-of-range input. */
export function parseLabel(geometry: Geometry, text: string): number {
  const match = /^([A-Za-z])(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`Bad cell label: ${text}`);
  const row = match[1].toUpperCase().charCodeAt(0) - 65;
  const col = parseInt(match[2], 10) - 1;
  if (row < 0 || row >= geometry.height || col < 0 || col >= geometry.width) {
    throw new Error(`Label out of range: ${text}`);
  }
  return row * geometry.width + col;
}
