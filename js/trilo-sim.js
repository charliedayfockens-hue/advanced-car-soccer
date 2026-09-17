// Sandbox physics for Trilo: a private one-car World that copies the real car and ball exactly, so a mechanic can be
// played out ahead of time. The simulation is deterministic, so a sandbox run matches the real game tick for tick
// until another car touches something.
window.Game = window.Game || {};

Game.TriloSim = (function () {
  const { Vec3, Mat3 } = Game.Math;
  const BODY_KEYS = ['pos', 'rot', 'linVel', 'angVel', 'totalForce', 'totalAngAccel', 'velocityImpulseCache', 'invInertiaWorld'];

  function copyBody(src, dst) {
    for (const k of BODY_KEYS) dst[k] = src[k].clone();
  }

  // Deep copy of plain state (Vec3, Mat3, arrays, objects); bodies are mapped through `bodies`
  function copyValue(v, bodies) {
    if (v instanceof Vec3 || v instanceof Mat3) return v.clone();
    if (Array.isArray(v)) return v.map(x => copyValue(x, bodies));
    if (v && typeof v === 'object') {
      if (bodies.has(v)) return bodies.get(v);
      const o = {};
      for (const k in v) o[k] = copyValue(v[k], bodies);
      return o;
    }
    return v;
  }

  function copyCar(srcWorld, srcIndex, dstWorld, dstIndex) {
    const s = srcWorld.cars[srcIndex], d = dstWorld.cars[dstIndex];
    const bodies = new Map([[srcWorld.ball, dstWorld.ball]]);
    srcWorld.cars.forEach(c => bodies.set(c.body, null));
    copyBody(s.body, d.body);
    d.state = copyValue(s.state, bodies);
    s.wheels.forEach((w, i) => {
      const dw = d.wheels[i];
      for (const k in w) dw[k] = copyValue(w[k], bodies);
    });
    d.controls = Object.assign({}, s.controls);
    d.ballHitTickApplied = s.ballHitTickApplied;
    d.lastBallTouchTick = s.lastBallTouchTick;
    d.boostUsedPerSecond = s.boostUsedPerSecond;
    d.isDemoed = s.isDemoed;
    d.demoTimer = s.demoTimer;
    d.carContact = Object.assign({}, s.carContact);
    d.team = s.team;
  }

  class Sandbox {
    constructor(cars) {
      this.world = new Game.World.World();
      this.world.setTeams(new Array(cars || 1).fill('blue'));
      this.car = this.world.cars[0];
      this.others = [];
    }

    // Copy car `index` (as car 0), the cars in `others` (as cars 1..n, which then hold their last inputs) and the
    // ball from a real world (or another sandbox's world)
    syncFrom(world, index, others) {
      const w = this.world, idx = [index].concat(others || []);
      if (w.cars.length !== idx.length) {
        w.setTeams(idx.map(() => 'blue'));
        this.car = w.cars[0];
      }
      copyBody(world.ball, w.ball);
      idx.forEach((src, dst) => copyCar(world, src, w, dst));
      this.others = idx.slice(1).map((src, k) => Object.assign({}, world.cars[src].controls));
      w.tickCount = world.tickCount;
      w.kickoffPause = world.kickoffPause;
      w.boostMode = world.boostMode;
      w.warmStart.clear();
      for (const [k, v] of world.warmStart) {
        if (k === 'bw') { w.warmStart.set(k, v); continue; }
        const m = /^(cw|cb)(\d+)(.*)$/.exec(k);
        const dst = m ? idx.indexOf(+m[2]) : -1;
        if (dst >= 0) w.warmStart.set(m[1] + dst + m[3], v);
      }
      return this;
    }

    // Park the car out of the simulation so only the ball moves (ball prediction)
    ballOnly() {
      this.world.cars.forEach(c => { c.isDemoed = true; c.demoTimer = 1e9; });
      return this;
    }

    step(controls) {
      if (!this.others.length) { this.world.step([controls]); return; }
      this.world.step([controls].concat(this.others));
    }
  }

  // Ball path for `seconds` (every tick) with no cars: [{t, pos:[x,y,z], vel:[x,y,z]}] in uu
  const predictor = new Sandbox();
  function predictBall(world, seconds, stride) {
    const BT = Game.RL.BT_TO_UU;
    predictor.syncFrom(world, 0).ballOnly();
    const w = predictor.world, out = [], n = Math.round(seconds * 120), k = stride || 1;
    w.kickoffPause = false;
    for (let i = 1; i <= n; i++) {
      w.step([]);
      if (i % k === 0) {
        const b = w.ball;
        out.push({ t: i / 120, pos: [b.pos.x * BT, b.pos.y * BT, b.pos.z * BT], vel: [b.linVel.x * BT, b.linVel.y * BT, b.linVel.z * BT] });
      }
    }
    return out;
  }

  return { Sandbox, copyBody, copyCar, predictBall };
})();
