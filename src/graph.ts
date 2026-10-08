/** [x1, y1, x2, y2, colorLane]: x is a lane index, y a fraction of the row height (0 top, 0.5 dot, 1 bottom). */
export type Segment = [number, number, number, number, number];

export interface GraphRow {
  col: number;
  segs: Segment[];
}

export interface GraphCommit {
  hash: string;
  parents: string[];
  /** Overrides `parents` for drawing (used to draw search results as one straight line). */
  graphParents?: string[];
}

/** Lays out a commit graph for a topo-ordered commit list. */
export function layout(commits: GraphCommit[]): { rows: GraphRow[]; maxLanes: number } {
  /** lane -> hash of the commit that lane is waiting for */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLanes = 1;

  const freeLane = () => {
    let i = lanes.indexOf(null);
    if (i === -1) {
      i = lanes.length;
      lanes.push(null);
    }
    return i;
  };

  for (const c of commits) {
    const segs: Segment[] = [];
    let col = lanes.indexOf(c.hash);
    if (col === -1) col = freeLane();

    // Incoming lines from the row above.
    for (let i = 0; i < lanes.length; i++) {
      const h = lanes[i];
      if (h === null) continue;
      if (h === c.hash) {
        segs.push([i, 0, col, 0.5, i]);
        if (i !== col) lanes[i] = null;
      } else {
        segs.push([i, 0, i, 1, i]);
      }
    }

    // Outgoing lines to the parents.
    const [first, ...rest] = c.graphParents || c.parents;
    lanes[col] = null;
    if (first) {
      const k = lanes.indexOf(first);
      if (k === -1) {
        lanes[col] = first;
        segs.push([col, 0.5, col, 1, col]);
      } else {
        segs.push([col, 0.5, k, 1, k]);
      }
    }
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = freeLane();
        lanes[k] = p;
      }
      segs.push([col, 0.5, k, 1, k]);
    }

    maxLanes = Math.max(maxLanes, lanes.length, col + 1);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ col, segs });
  }

  return { rows, maxLanes };
}
