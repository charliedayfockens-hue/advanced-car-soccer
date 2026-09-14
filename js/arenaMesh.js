// Builds the lower arena shell (floor ramps, padded walls, goal boxes and goal-mouth rims) straight
// from the collision SDF (Game.Arena) with surface nets. Every vertex is projected onto the true
// surface and normals come from the SDF gradient, so what you see is exactly what you hit. Faces
// point into the open arena, so with front-face culling the walls vanish when seen from behind.
// The flat glass upper walls and ceiling are simple sweeps built elsewhere, starting at TOP_Z.
// Output is in RL coordinates (x, y, z-up), uu; triangles are grouped by surface type.
window.Game = window.Game || {};

Game.ArenaMesh = (function () {
  const G = Game.ArenaGeom;
  const GROUPS = ['ramp', 'lower', 'goal', 'frame'];
  const TOP_Z = 1060;

  function classify(cx, cy, cz) {
    const ax = Math.abs(cx), ay = Math.abs(cy);
    const gw = G.goalHalfWidth, gh = G.goalHeight, Y = G.extentY;
    if (ax < gw + 90 && cz < gh + 90 && ay > Y - 70) return ay < Y + 40 ? 3 : 2;
    return cz < 250 ? 0 : 1;
  }

  function build(res) {
    res = res || 40;
    const sdf = Game.Arena.sdf, normalAt = Game.Arena.normal;
    const x0 = -G.extentX - 2 * res, y0 = -(G.extentY + G.goalDepth) - 2 * res, z0 = -2 * res;
    const nx = Math.ceil((2 * -x0) / res) + 1;
    const ny = Math.ceil((2 * -y0) / res) + 1;
    const nz = Math.ceil((TOP_Z + 4 * res - z0) / res) + 1;
    const sxy = nx * ny;
    const band = G.floorRampRadius + 3 * res;
    const gw = G.goalHalfWidth, Y = G.extentY;

    // Which columns need real samples: near a wall, or in a goal mouth. Everywhere else is open
    // air above the flat floor, which is drawn as its own textured mesh.
    const columnNear = new Uint8Array(sxy);
    for (let j = 0; j < ny; j++) {
      const ay = Math.abs(y0 + j * res);
      for (let i = 0; i < nx; i++) {
        const ax = Math.abs(x0 + i * res);
        const nearGoal = ax < gw + 400 && ay > Y - 500;
        const lateral = Math.min(G.extentX - ax, Y - ay, (G.cornerPlane - ax - ay) / Math.SQRT2);
        columnNear[j * nx + i] = nearGoal || lateral < band ? 1 : 0;
      }
    }

    const field = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const z = z0 + k * res;
      for (let j = 0; j < ny; j++) {
        const y = y0 + j * res, row = k * sxy + j * nx;
        for (let i = 0; i < nx; i++) {
          field[row + i] = columnNear[j * nx + i] ? sdf(x0 + i * res, y, z) : (z < 0 ? -1 : 1e4);
        }
      }
    }

    const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
    const cellVert = new Int32Array(cnx * cny * cnz).fill(-1);
    const pos = [], nrm = [];
    const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const v = new Float32Array(8);
    const maxMove = res * 1.5;

    for (let k = 0; k < cnz; k++) {
      for (let j = 0; j < cny; j++) {
        for (let i = 0; i < cnx; i++) {
          if (!columnNear[j * nx + i] && !columnNear[(j + 1) * nx + i + 1]) continue;
          let neg = 0;
          for (let c = 0; c < 8; c++) {
            const o = corners[c];
            const val = field[(k + o[2]) * sxy + (j + o[1]) * nx + (i + o[0])];
            v[c] = val;
            if (val < 0) neg++;
          }
          if (neg === 0 || neg === 8) continue;
          let px = 0, py = 0, pz = 0, cnt = 0;
          for (const [a, b] of edges) {
            if ((v[a] < 0) === (v[b] < 0)) continue;
            const t = v[a] / (v[a] - v[b]);
            const oa = corners[a], ob = corners[b];
            px += oa[0] + (ob[0] - oa[0]) * t;
            py += oa[1] + (ob[1] - oa[1]) * t;
            pz += oa[2] + (ob[2] - oa[2]) * t;
            cnt++;
          }
          const sx = x0 + (i + px / cnt) * res, sy = y0 + (j + py / cnt) * res, sz = z0 + (k + pz / cnt) * res;
          const n0 = normalAt(sx, sy, sz);
          let d = sdf(sx, sy, sz);
          let qx = sx - n0.x * d, qy = sy - n0.y * d, qz = sz - n0.z * d;
          d = sdf(qx, qy, qz);
          qx -= n0.x * d; qy -= n0.y * d; qz -= n0.z * d;
          const mx = qx - sx, my = qy - sy, mz = qz - sz;
          if (mx * mx + my * my + mz * mz > maxMove * maxMove) { qx = sx; qy = sy; qz = sz; }
          const n = normalAt(qx, qy, qz);
          cellVert[k * cnx * cny + j * cnx + i] = pos.length / 3;
          pos.push(qx, qy, qz);
          nrm.push(n.x, n.y, n.z);
        }
      }
    }

    const cellIndex = (i, j, k) => cellVert[k * cnx * cny + j * cnx + i];
    const groups = GROUPS.map(() => []);

    function emit(a, b, c, d, openPositive) {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      const q = openPositive ? [a, b, c, d] : [a, d, c, b];
      let cx = 0, cy = 0, cz = 0, nzs = 0;
      for (const id of q) { cx += pos[id * 3]; cy += pos[id * 3 + 1]; cz += pos[id * 3 + 2]; nzs += nrm[id * 3 + 2]; }
      cx /= 4; cy /= 4; cz /= 4; nzs /= 4;
      if (cz < 1.5 && nzs > 0.95) return; // flat floor
      if (cz > TOP_Z + 1) return;         // glass sweep takes over above here
      groups[classify(cx, cy, cz)].push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }

    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const here = field[k * sxy + j * nx + i];
          const solid = here < 0;
          if (i < nx - 1 && j >= 1 && j < cny && k >= 1 && k < cnz) {
            if (solid !== (field[k * sxy + j * nx + i + 1] < 0)) emit(cellIndex(i, j - 1, k - 1), cellIndex(i, j, k - 1), cellIndex(i, j, k), cellIndex(i, j - 1, k), solid);
          }
          if (j < ny - 1 && i >= 1 && i < cnx && k >= 1 && k < cnz) {
            if (solid !== (field[k * sxy + (j + 1) * nx + i] < 0)) emit(cellIndex(i - 1, j, k - 1), cellIndex(i - 1, j, k), cellIndex(i, j, k), cellIndex(i, j, k - 1), solid);
          }
          if (k < nz - 1 && i >= 1 && i < cnx && j >= 1 && j < cny) {
            if (solid !== (field[(k + 1) * sxy + j * nx + i] < 0)) emit(cellIndex(i - 1, j - 1, k), cellIndex(i, j - 1, k), cellIndex(i, j, k), cellIndex(i - 1, j, k), solid);
          }
        }
      }
    }

    const index = new Uint32Array(groups.reduce((s, g) => s + g.length, 0));
    const ranges = [];
    let off = 0;
    groups.forEach((g, gi) => {
      index.set(g, off);
      ranges.push({ name: GROUPS[gi], start: off, count: g.length });
      off += g.length;
    });
    return { positions: new Float32Array(pos), normals: new Float32Array(nrm), index, groups: ranges };
  }

  let cache = null;
  function get() { return cache || (cache = build(40)); }

  return { build, get, GROUPS, TOP_Z };
})();
