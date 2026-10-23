import * as THREE from "three";

// Walkable-area grid built from the cemetery's height maps. A cell is walkable when it has
// ground and nothing standing on it taller than he can step over (graves, fences, trees, the
// crypt block him), with a margin for his body width. Low edging and curbs can be stepped over
// but cost more, so he prefers open ground. Paths are found with A* and then straightened so he
// walks clean lines between corners instead of zig-zagging from cell to cell.
export class NavGrid {
  constructor(h, { cell = 0.2, radius = 0.38, step = 0.3, low = 0.1, plantStep = 0.28, plantCover = 0.4 } = {}) {
    this.cell = cell;
    this.radius = radius;
    this.min = h.min.clone();
    this.cols = Math.ceil((h.res * h.cellX) / cell);
    this.rows = Math.ceil((h.res * h.cellZ) / cell);
    const n = this.cols * this.rows;
    const raw = new Uint8Array(n).fill(1);
    const sum = new Float32Array(n);
    const count = new Uint16Array(n);
    const rise = new Float32Array(n);
    const leafy = new Uint16Array(n);
    for (let j = 0; j < h.res; j++) {
      for (let i = 0; i < h.res; i++) {
        const g = h.ground[j * h.res + i];
        if (g < -50) continue;
        const c = Math.floor((j * h.cellZ) / cell) * this.cols + Math.floor((i * h.cellX) / cell);
        sum[c] += g;
        count[c]++;
        rise[c] = Math.max(rise[c], h.top[j * h.res + i] - g);
        if (h.plants && h.plants[j * h.res + i] - g > plantStep) leafy[c]++;
      }
    }
    // Thin grass and a few stems are walkable; a cell mostly filled with tall foliage (a
    // pumpkin, a bush, a hedge) is not.
    for (let c = 0; c < n; c++) if (count[c] > 4 && rise[c] <= step && leafy[c] < count[c] * plantCover) raw[c] = 0;
    this.groundY = sum.map((s, c) => (count[c] ? s / count[c] : 0));
    this.cost = rise.map((r) => (r > low ? 4 : 1));

    // Grow the obstacles by his radius so his shoulders and coat clear them too.
    const r = Math.ceil(radius / cell);
    this.blocked = new Uint8Array(n);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        let hit = raw[y * this.cols + x];
        for (let dy = -r; dy <= r && !hit; dy++) {
          for (let dx = -r; dx <= r && !hit; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= this.cols || yy >= this.rows || raw[yy * this.cols + xx]) hit = 1;
          }
        }
        this.blocked[y * this.cols + x] = hit;
      }
    }
  }

  // Marks a round obstacle added after the map was built (the gift gravestone), with the same
  // margin for his body as everything else.
  block(x, z, radius) {
    const r = radius + this.radius;
    const [cx, cy] = this.toCell(x, z);
    const n = Math.ceil(r / this.cell);
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        const wx = this.min.x + (cx + dx + 0.5) * this.cell - x;
        const wz = this.min.z + (cy + dy + 0.5) * this.cell - z;
        if (wx * wx + wz * wz <= r * r && cx + dx >= 0 && cy + dy >= 0 && cx + dx < this.cols && cy + dy < this.rows) this.blocked[(cy + dy) * this.cols + cx + dx] = 1;
      }
    }
  }

  // True when he could swing his arms and body `reach` metres in any direction from (x, z)
  // without touching anything (for flips, push-ups and handstands).
  clearAround(x, z, reach) {
    const r = Math.max(0, reach - this.radius);
    const [cx, cy] = this.toCell(x, z);
    const n = Math.ceil(r / this.cell);
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * dx + dy * dy) * this.cell * this.cell <= r * r && !this.free(cx + dx, cy + dy)) return false;
    return true;
  }

  // The closest point with room for a stunt of the given reach, or null.
  roomFor(x, z, reach, maxDistance = 5) {
    const [sx, sy] = this.toCell(x, z);
    const steps = Math.ceil(maxDistance / this.cell);
    for (let r = 0; r <= steps; r++) {
      let best = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const p = this.toWorld(sx + dx, sy + dy);
          if (!this.free(sx + dx, sy + dy) || !this.clearAround(p.x, p.y, reach)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  toCell(x, z) {
    return [Math.floor((x - this.min.x) / this.cell), Math.floor((z - this.min.z) / this.cell)];
  }

  toWorld(cx, cy) {
    return new THREE.Vector2(this.min.x + (cx + 0.5) * this.cell, this.min.z + (cy + 0.5) * this.cell);
  }

  free(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows && !this.blocked[cy * this.cols + cx];
  }

  walkable(x, z) {
    return this.free(...this.toCell(x, z));
  }

  // The closest walkable point, for spots or positions that ended up inside an obstacle.
  nearest(x, z) {
    const [sx, sy] = this.toCell(x, z);
    if (this.free(sx, sy)) return new THREE.Vector2(x, z);
    for (let r = 1; r < Math.max(this.cols, this.rows); r++) {
      let best = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !this.free(sx + dx, sy + dy)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = [sx + dx, sy + dy];
          }
        }
      }
      if (best) return this.toWorld(...best);
    }
    return new THREE.Vector2(x, z);
  }

  // True when a straight walk from a to b stays on walkable cells.
  clear(a, b) {
    const d = a.distanceTo(b);
    const steps = Math.ceil(d / (this.cell * 0.4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.walkable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }

  // A* over the grid (8 neighbours, no corner cutting), then straightened.
  path(fromX, fromZ, toX, toZ) {
    const start = this.nearest(fromX, fromZ);
    const goal = this.nearest(toX, toZ);
    const [sx, sy] = this.toCell(start.x, start.y);
    const [gx, gy] = this.toCell(goal.x, goal.y);
    const cols = this.cols;
    const key = (x, y) => y * cols + x;
    const g = new Map([[key(sx, sy), 0]]);
    const came = new Map();
    const open = [[0, sx, sy]];
    const h = (x, y) => {
      const dx = Math.abs(x - gx);
      const dy = Math.abs(y - gy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const closed = new Set();
    let found = false;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, x, y] = open.splice(bi, 1)[0];
      const k = key(x, y);
      if (closed.has(k)) continue;
      closed.add(k);
      if (x === gx && y === gy) {
        found = true;
        break;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.free(nx, ny)) continue;
          if (dx && dy && (!this.free(x + dx, y) || !this.free(x, y + dy))) continue;
          const nk = key(nx, ny);
          const cost = g.get(k) + (dx && dy ? Math.SQRT2 : 1) * this.cost[nk];
          if (cost < (g.get(nk) ?? Infinity)) {
            g.set(nk, cost);
            came.set(nk, k);
            open.push([cost + h(nx, ny), nx, ny]);
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = key(gx, gy); k !== undefined; k = came.get(k)) cells.unshift(this.toWorld(k % cols, Math.floor(k / cols)));
    cells[0] = start;
    cells[cells.length - 1] = goal;
    // String-pull: keep only the corners he cannot see past.
    const out = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.clear(cells[i], cells[j])) j--;
      out.push(cells[j]);
      i = j;
    }
    return out;
  }
}
