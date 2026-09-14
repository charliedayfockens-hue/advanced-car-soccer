// Soccar arena collision as an exact signed distance field (uu, positive = open space).
// Floor, ceiling, side/back/corner walls with curved ramps, goal openings with rounded posts and a
// goal box whose inner edges are all rounded. Used for ball contacts, car-body contacts, wheel ray
// casts, and to generate the visual arena mesh so visuals and collision always match.
window.Game = window.Game || {};

Game.Arena = (function () {
  const G = Game.ArenaGeom;
  const S2 = Math.SQRT2;
  const sqrt = Math.sqrt;

  const X = G.extentX, Y = G.extentY, C = G.cornerPlane, H = G.height;
  const RC = G.cornerRoundRadius;

  // Inset (by RC) octagon quadrant vertices, used for the exact rounded-polygon distance.
  const IN_X = X - RC, IN_Y = Y - RC, IN_C = C - RC * S2;
  const A = { x: IN_X, y: IN_C - IN_X };   // side wall / corner wall
  const B = { x: IN_C - IN_Y, y: IN_Y };   // corner wall / back wall

  function segDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    let t = ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
    return sqrt(dx * dx + dy * dy);
  }

  // Distance to the octagonal wall outline in the XY plane (ax, ay >= 0), vertical edges rounded.
  function octagonDist(ax, ay) {
    const s1 = IN_X - ax, s2 = IN_Y - ay, s3 = (IN_C - ax - ay) / S2;
    const m = Math.min(s1, s2, s3);
    if (m >= 0) return RC + m;
    const d = Math.min(
      segDist(ax, ay, A.x, -A.y, A.x, A.y),
      segDist(ax, ay, A.x, A.y, B.x, B.y),
      segDist(ax, ay, B.x, B.y, -B.x, B.y)
    );
    return RC - d;
  }

  // Goal cavity: a box with every inner edge rounded by goalCornerRadius. It extends well into the
  // field (and below the floor) so only its side walls, roof and back wall matter.
  const GC = (() => {
    const y0 = Y - 1500, y1 = Y + G.goalDepth, z0 = -1000, z1 = G.goalHeight;
    return { cy: (y0 + y1) / 2, hy: (y1 - y0) / 2, cz: (z0 + z1) / 2, hz: (z1 - z0) / 2, hx: G.goalHalfWidth, r: G.goalCornerRadius };
  })();

  // Open distance inside the goal cavity (positive inside)
  function goalCavityDist(ax, ay, z) {
    const r = GC.r;
    const qx = ax - GC.hx + r, qy = Math.abs(ay - GC.cy) - GC.hy + r, qz = Math.abs(z - GC.cz) - GC.hz + r;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
    const inner = Math.max(qx, qy, qz);
    return -(sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0) - r);
  }

  function lateralDist(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y);
    if (ax < 2000 && ay > 4000) {
      // Near a goal: field walls are flat here. Open space = field OR goal cavity, with the
      // post/crossbar edges between them rounded by goalEdgeRadius.
      const field = Math.min(X - ax, (C - ax - ay) / S2, Y - ay);
      const cavity = goalCavityDist(ax, ay, z);
      const rp = G.goalEdgeRadius;
      const ux = rp + field > 0 ? rp + field : 0, uy = rp + cavity > 0 ? rp + cavity : 0;
      return Math.min(-rp, Math.max(field, cavity)) + sqrt(ux * ux + uy * uy);
    }
    return octagonDist(ax, ay);
  }

  function sdf(x, y, z) {
    const l = lateralDist(x, y, z);
    const rb = G.floorRampRadius, rt = G.ceilingRampRadius;
    const c = H - z;
    if (l < rb && z < rb) { const a = rb - l, b = rb - z; return rb - sqrt(a * a + b * b); }
    if (l < rt && c < rt) { const a = rt - l, b = rt - c; return rt - sqrt(a * a + b * b); }
    return Math.min(l, z, c);
  }

  function normal(x, y, z) {
    const h = 0.5;
    const nx = sdf(x + h, y, z) - sdf(x - h, y, z);
    const ny = sdf(x, y + h, z) - sdf(x, y - h, z);
    const nz = sdf(x, y, z + h) - sdf(x, y, z - h);
    const l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / l, y: ny / l, z: nz / l };
  }

  // Sphere-traced ray cast (uu). dir must be unit length. Returns { t, point, normal } or null.
  function rayCast(ox, oy, oz, dx, dy, dz, maxLen) {
    let t = 0;
    let d = sdf(ox, oy, oz);
    if (d <= 0) return null; // ray starts inside the arena geometry (backface)
    for (let i = 0; i < 160; i++) {
      if (d < 0.01) break;
      t += d;
      if (t > maxLen) return null;
      d = sdf(ox + dx * t, oy + dy * t, oz + dz * t);
    }
    if (d > 0.5) return null;
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    return { t, point: { x: px, y: py, z: pz }, normal: normal(px, py, pz) };
  }

  return { sdf, normal, rayCast };
})();
