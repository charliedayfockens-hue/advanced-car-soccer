// Trilo: a freestyle bot built on Nexto. Nexto's network plays the game (rotations, challenges, saves). Whenever
// Trilo gets to the ball first it goes for a freestyle: before committing, it plays each option out in a private
// copy of the physics (js/trilo-sim.js) and picks one that works:
//  - loose ball on the ground: catch it onto the roof (or scoop a bouncing ball) and dribble
//  - dribbling: front, 45 and musty flicks, or pop it into an air dribble or a flip reset
//  - ball in the air: flip resets (then shoot with the flip), air dribbles, aerial shots and double taps
//  - near a side wall with the ball high: ceiling shots
// The simulation is deterministic, so a plan plays out in the real game exactly as simulated unless another car
// gets involved; Trilo watches for that and re-plans. Movement tech (wave dashes, half flips, speed flips, wall
// dashes) runs on top of Nexto the rest of the time. Controls follow RLBot conventions.
window.Game = window.Game || {};

(function () {
  const RL = Game.RL, BT = RL.BT_TO_UU, { Vec3 } = Game.Math, Sim = Game.TriloSim;
  const BALL_R = 92.75, G = 650, BOOST_AIR = RL.BOOST_ACCEL_AIR, TICK = 1 / 120, DRAG = -Math.log(1 - RL.BALL_DRAG);

  // ---------------- vectors (plain arrays, uu) ----------------
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.sqrt(dot(a, a));
  const normalize = a => { const n = norm(a); return n > 1e-9 ? mul(a, 1 / n) : [0, 0, 0]; };
  const flat = a => [a[0], a[1], 0];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const V = a => new Vec3(a[0], a[1], a[2]);
  const uu = v => [v.x * BT, v.y * BT, v.z * BT];
  const blank = () => ({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });

  // Seeded random numbers, so a plan's parameters are the same in the sandbox and the real game
  function rng(seed) {
    let x = (seed | 0) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; };
  }

  // ---------------- state ----------------
  function read(world, index, withOthers) {
    const car = world.cars[index], b = car.body, R = b.rot, st = car.state, ball = world.ball;
    const sign = car.team === 'blue' ? 1 : -1;
    const s = {
      world, car, index, st, sign, tick: world.tickCount,
      pos: uu(b.pos), vel: uu(b.linVel), ang: [b.angVel.x, b.angVel.y, b.angVel.z],
      f: [R.e[0], R.e[3], R.e[6]], r: [R.e[1], R.e[4], R.e[7]], u: [R.e[2], R.e[5], R.e[8]],
      onGround: st.isOnGround, boost: st.boost,
      canFlip: !st.hasDoubleJumped && !st.hasFlipped && !st.isAutoFlipping && (!st.hasJumped || st.airTimeSinceJump < 1.2),
      ball: uu(ball.pos), ballVel: uu(ball.linVel),
      theirGoal: [0, sign * 5120, 320], ownGoal: [0, -sign * 5120, 320]
    };
    s.toBall = sub(s.ball, s.pos);
    s.dist = norm(s.toBall);
    s.speed = norm(s.vel);
    s.fwdSpeed = dot(s.vel, s.f);
    s.ballOnRoof = onRoof(s);
    if (withOthers) {
      s.opps = []; s.mates = [];
      world.cars.forEach((c, i) => {
        if (i === index || c.isDemoed) return;
        const o = { car: c, index: i, pos: uu(c.body.pos), vel: uu(c.body.linVel) };
        (c.team === car.team ? s.mates : s.opps).push(o);
      });
    }
    return s;
  }

  // Ball resting on the roof: relative position in the car's frame
  function onRoof(s) {
    const l = [dot(s.toBall, s.f), dot(s.toBall, s.r), dot(s.toBall, s.u)];
    return l[2] > 95 && l[2] < 190 && Math.hypot(l[0] - 20, l[1]) < 75 && norm(sub(s.ballVel, s.vel)) < 450;
  }

  // Free flight of the ball with drag (no bounces): position and velocity after t seconds
  function ballistic(p, v, t) {
    const e = Math.exp(-DRAG * t), gl = -G / DRAG;
    const vt = [v[0] * e, v[1] * e, gl + (v[2] - gl) * e];
    const k = (1 - e) / DRAG;
    return { pos: [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + gl * t + (v[2] - gl) * k], vel: vt };
  }

  // Arena bounds for positions we aim the car at
  const inArena = (p, m) => Math.abs(p[0]) < 4096 - m && Math.abs(p[1]) < 5120 - m && p[2] > 0 && p[2] < 2044 - m;

  // ---------------- control helpers ----------------
  function orient(s, forward, up, c, gain) {
    Game.BotControl.reorient(s.car, V(normalize(forward)), V(normalize(up)), c, gain || 11);
  }

  function driveTo(s, target, c, speed) {
    const d = sub(target, s.pos), phi = Math.atan2(dot(d, s.r), dot(d, s.f));
    c.steer = clamp(3 * phi, -1, 1);
    c.handbrake = Math.abs(phi) > 1.7 && s.speed > 500 && s.onGround;
    const want = speed === undefined ? 2300 : speed;
    if (s.fwdSpeed < want - 40) { c.throttle = 1; c.boost = want - s.fwdSpeed > 250 && Math.abs(phi) < 0.35 && s.fwdSpeed < 2250 && s.onGround; }
    else if (s.fwdSpeed > want + 150) c.throttle = -1;
    else c.throttle = 0.03;
    return phi;
  }

  // Waypoint that steers around the ball when it sits between the car and the target
  function around(s, target, obstacle, radius) {
    const a = flat(s.pos), d = sub(flat(target), a), len = norm(d);
    if (len < 1) return target;
    const u = mul(d, 1 / len), o = sub(flat(obstacle), a), along = dot(o, u);
    if (along < 0 || along > len) return target;
    const perp = sub(o, mul(u, along)), off = norm(perp);
    if (off > radius) return target;
    const side = off > 1 ? mul(perp, -1 / off) : [-u[1], u[0], 0];
    return add(flat(obstacle), mul(side, radius + 120));
  }

  // Constant thrust needed to be at P after T seconds when the last `coast` seconds are spent without thrust
  function thrustFor(s, P, T, coast) {
    coast = Math.min(coast || 0, T * 0.95);
    const tau = Math.max(T - coast, 0.02);
    const disp = sub(sub(P, s.pos), add(mul(s.vel, T), [0, 0, -0.5 * G * T * T]));
    return mul(disp, 1 / (tau * tau / 2 + tau * coast));
  }

  // Nose along the thrust and boost when lined up; air throttle trims what's left
  function applyThrust(s, a, c, up, minBoost) {
    const need = norm(a), dir = need > 1 ? mul(a, 1 / need) : s.f;
    // Roof hint perpendicular to the nose; when the hint is nearly along the nose, keep the current roll
    let hint = up || [0, 0, 1];
    hint = sub(hint, mul(dir, dot(hint, dir)));
    if (norm(hint) < 0.35) hint = sub(s.u, mul(dir, dot(s.u, dir)));
    orient(s, dir, normalize(hint), c);
    const al = dot(s.f, dir);
    c.boost = s.boost > 0 && al > 0.8 && need > (minBoost === undefined ? 300 : minBoost);
    c.throttle = clamp(dot(a, s.f) / 66, -1, 1);
    return need;
  }

  // Dodge toward a world direction (front = pitch -1, right = yaw +1)
  function dodgeToward(s, dir, c) {
    const l = [dot(dir, s.f), dot(dir, s.r)], k = Math.max(Math.abs(l[0]), Math.abs(l[1]), 1e-6);
    c.jump = true;
    c.pitch = -l[0] / k;
    c.yaw = clamp(l[1] / k, -1, 1);
    c.roll = 0;
  }

  // Wheels-down landing
  function recover(s, c) {
    let fwd = flat(s.vel);
    if (norm(fwd) < 50) fwd = flat(s.f);
    if (norm(fwd) < 1e-3) fwd = [1, 0, 0];
    orient(s, fwd, [0, 0, 1], c, 5);
    c.throttle = 1;
  }

  // ---------------- mechanics ----------------
  // step(s, c) fills the controls and returns undefined while running, 'done' or 'fail'. They only use the
  // state they're given (no other cars), so they run the same way in the sandbox and the real game.
  // `stats` collects what happened for scoring a plan.

  // Carry the ball on the roof toward a direction (gains tuned in the sandbox)
  const DRIBBLE = { f0: 26, kp: 68.5, kd: 5.9, kv: 0.086, maxOff: 150, boostA: 294, sr: 0.0195, svr: 0.00113, sh: 2.75, shMax: 0.072, slow: 0.4, minFrac: 0.5 };
  function dribbleControl(s, c, goalDir, speed) {
    const P = DRIBBLE, d = s.toBall, dv = sub(s.ballVel, s.vel);
    const ef = dot(d, s.f) - P.f0, er = dot(d, s.r), vf = dot(dv, s.f), vr = dot(dv, s.r);
    const gh = Math.atan2(goalDir[0] * s.r[0] + goalDir[1] * s.r[1], goalDir[0] * s.f[0] + goalDir[1] * s.f[1]);
    const vT = speed * clamp(1 - P.slow * Math.abs(gh), P.minFrac, 1);
    const efT = clamp((vT - dot(s.ballVel, s.f)) * P.kv, -P.maxOff, P.maxOff);
    const a = P.kp * (ef - efT) + P.kd * vf;
    if (a > 0) { c.throttle = clamp(a / 1600, 0, 1); c.boost = a > P.boostA && s.fwdSpeed < 2250; }
    else if (a > -525) c.throttle = clamp((a + 525) / 1600, 0, 1) * 0.3;
    else c.throttle = -1;
    c.steer = clamp(P.sr * er + P.svr * vr + clamp(P.sh * gh, -P.shMax, P.shMax), -1, 1);
    return gh;
  }

  class Dribble {
    constructor(p) { this.name = 'dribble'; this.p = p || {}; this.t = 0; this.lost = 0; }
    step(s, c) {
      this.t++;
      const dir = normalize(flat(sub(s.theirGoal, s.ball)));
      dribbleControl(s, c, dir, this.p.speed || 1100);
      const l = [dot(s.toBall, s.f), dot(s.toBall, s.r), dot(s.toBall, s.u)];
      if (l[2] < 80 || Math.hypot(l[0], l[1]) > 150 || !s.onGround) { if (++this.lost > 6) return 'fail'; } else this.lost = 0;
      if (this.p.ticks && this.t >= this.p.ticks) return 'done';
    }
  }

  // Along-track speed control on the ground: reach `dist` uu ahead in T seconds (constant acceleration)
  function arrive(s, c, dist, T, vEnd) {
    T = Math.max(T, 1 / 60);
    let a = 2 * (dist - s.fwdSpeed * T) / (T * T);
    if (vEnd !== undefined && T < 0.25) a = a * 0.5 + (vEnd - s.fwdSpeed) / Math.max(T, 0.08) * 0.5;
    if (a > 0) {
      c.throttle = clamp(a / 1500, 0, 1);
      c.boost = a > 1500 && s.fwdSpeed < 2250;
    } else if (a > -525) {
      c.throttle = clamp((a + 525) / 1500, 0, 1) * 0.25;
    } else {
      c.throttle = s.fwdSpeed > 0 ? clamp(a / 3500, -1, -0.05) : -1;
    }
    return a;
  }

  // Get a loose ball onto the roof. Rolling ball: line up behind it and bump it at `dv` over its speed so it hops;
  // then (like any bouncing ball) arrive under it with the roof as it comes down, moving with it.
  // p: dv, back, lead (landing spot behind the ball centre), steer, hop
  class Catch {
    constructor(p) { this.name = 'catch'; this.p = p; this.t = 0; this.held = 0; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (s.ballOnRoof) {
        dribbleControl(s, c, normalize(flat(sub(s.theirGoal, s.ball))), 900);
        if (++this.held >= 40) { if (stats) stats.caught = true; return 'done'; }
        return this.t > 600 ? 'fail' : undefined;
      }
      this.held = 0;
      if (this.popT) {
        // holding the pop jump, then land; a new pop is allowed a second after landing
        this.popT++;
        if (this.popT <= p.popHold) { c.jump = true; c.throttle = 1; c.pitch = p.popPitch || 0; return; }
        if (s.onGround && this.popT > p.popHold + 120) this.popT = 0;
      }
      if (!s.onGround && this.t > 20) return this.t > 600 ? 'fail' : (recover(s, c), undefined);
      const bv = flat(s.ballVel), bs = norm(bv);
      const goalDir = normalize(flat(sub(s.theirGoal, s.ball)));
      const rel0 = sub(s.ball, s.pos), relF0 = dot(rel0, s.f), relR0 = dot(rel0, s.r);
      if (!p.slide && s.ball[2] > 95 && s.ball[2] < 175 && relF0 > 90 && relF0 < 230 && Math.abs(relR0) < 80 && Math.abs(s.ballVel[2]) < 250) {
        // Ball riding the hood: drive a little faster than it so it rolls back over the nose onto the roof
        c.steer = clamp(relR0 * 0.02, -1, 1);
        arrive(s, c, relF0 - 20, p.scoop, dot(s.ballVel, s.f));
        return this.t > 700 ? 'fail' : undefined;
      }
      if (p.slide && s.ball[2] > 100 && s.ball[2] < 220 && relF0 > 40 && relF0 < 300 && Math.abs(relR0) < 90) {
        // Small hop right in front after the bump: get under it fast before it lands
        c.steer = clamp(relR0 * 0.03, -1, 1);
        const want = dot(s.ballVel, s.f) + (relF0 - 20) * p.slide;
        c.throttle = s.fwdSpeed < want ? 1 : -1;
        c.boost = s.fwdSpeed < want - 150 && s.fwdSpeed < 2250;
        return this.t > 700 ? 'fail' : undefined;
      }
      if (s.ball[2] > p.hop || Math.abs(s.ballVel[2]) > 120) {
        // Under the ball when it comes down to roof height
        let T = fallTime(s.ball, s.ballVel, 150);
        if (T === null) T = 0.05;
        const land = ballistic(s.ball, s.ballVel, T);
        const dir = bs > 150 ? normalize(bv) : normalize(flat(s.f));
        const target = sub(flat(land.pos), mul(dir, p.lead));
        const d = sub(target, s.pos);
        const phi = Math.atan2(dot(d, s.r), Math.max(dot(d, s.f), 60));
        if (T > 0.6 && dot(normalize(flat(d)), s.f) < 0.5) {
          // Far off or facing away: get heading toward the landing spot first
          driveTo(s, target, c, Math.min(2300, norm(flat(d)) / T + 300));
        } else {
          c.steer = clamp(phi * p.steer, -1, 1);
          arrive(s, c, dot(d, s.f), T, dot(land.vel, s.f));
        }
        return this.t > 700 ? 'fail' : undefined;
      }
      // Rolling ball: line up behind it along its path (bent toward goal), then bump it
      // line up with the way the ball rolls (or straight from where the car is for a slow ball); the dribble turns
      // toward goal afterwards
      // head-on (meeting the ball) takes the pace off it so the car can get under the hop; from behind needs a slow ball
      const along = bs > 250 ? (p.headOn ? mul(normalize(bv), -1) : normalize(add(normalize(bv), mul(goalDir, p.goalBias || 0)))) : normalize(flat(sub(s.ball, s.pos)));
      const rel = flat(sub(s.ball, s.pos)), relAlong = dot(rel, along), side = dot(rel, [-along[1], along[0], 0]);
      const facing = dot(normalize(flat(s.f)), along);
      if (relAlong < 150 || Math.abs(side) > 90 || facing < 0.9) {
        const lead = clamp(norm(rel) / 1500, 0.2, 1.2);
        const behind = sub(add(s.ball, mul(bv, lead)), mul(along, p.back));
        const way = around(s, behind, add(s.ball, mul(bv, 0.2)), 260);
        const dWay = norm(flat(sub(behind, s.pos)));
        driveTo(s, way, c, Math.min(2300, Math.sqrt(bs * bs + 2 * (p.brake || 2200) * dWay) * 0.8 + 200));
      } else {
        // Pop it: a little jump into the ball as the nose reaches it knocks it up, and it's caught like a bounce
        if (p.popDist && !this.popT && relAlong < p.popDist && s.onGround) {
          this.popT = 1;
          c.jump = true; c.throttle = 1; c.pitch = p.popPitch || 0;
          return;
        }
        // brake in time to reach the ball at the push speed
        const aim = add(s.ball, mul(bv, 0.08)), contact = dot(bv, s.f) + p.dv;
        const want = Math.min(2300, Math.sqrt(Math.max(0, contact * contact + 2 * (p.brake || 2200) * Math.max(0, relAlong - 160))));
        driveTo(s, aim, c, want);
        c.boost = c.boost && relAlong > 800;
      }
      return this.t > 700 ? 'fail' : undefined;
    }
  }

  // Seconds until the ball (free flight) comes down through height h, or null
  function fallTime(p, v, h) {
    // z(t) = p + v t - G/2 t^2 (drag ignored for timing)
    const a = -G / 2, b = v[2], cc = p[2] - h, disc = b * b - 4 * a * cc;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 ? t : null;
  }

  // Flicks off a dribble, as a timed input program found by searching in the sandbox:
  // pre ticks adjusting the dribble (throttle shift), jump held `hold` ticks (p1/y1/r1), released `wait` ticks
  // (p2/y2/r2), the dodge (dp/dy), then `keep` ticks of kp/ky/kr (flip cancel / air roll)
  const FLICKS = {
    front: { pre: 35, shift: -0.29, hold: 26, p1: -0.9, y1: 0.2, r1: -0.02, wait: 18, p2: 0.22, y2: 0.01, r2: 0.01, dp: -0.99, dy: 0, keep: 4, kp: -0.44, ky: -1, kr: -0.61 },
    musty: { pre: 24, shift: -0.16, hold: 14, p1: 0.2, y1: -0.2, r1: 0.04, wait: 17, p2: 0.69, y2: 1, r2: 0.48, dp: 1, dy: 0, keep: 12, kp: 0.49, ky: 0.3, kr: -0.74 },
    '45': { pre: 19, shift: 0.02, hold: 15, p1: -0.09, y1: -0.74, r1: -0.38, wait: 18, p2: 1, y2: -1, r2: -0.7, dp: -1, dy: 1, keep: 7, kp: -0.09, ky: -0.26, kr: 0.65 }
  };
  const mirror = p => Object.assign({}, p, { y1: -p.y1, r1: -p.r1, y2: -p.y2, r2: -p.r2, dy: -p.dy, ky: -p.ky, kr: -p.kr });

  class Flick {
    constructor(kind, p) { this.name = kind === 'musty' ? 'musty flick' : kind === '45' ? '45 flick' : 'front flick'; this.p = p; this.t = 0; }
    step(s, c, stats) {
      const p = this.p, k = ++this.t - p.pre;
      c.throttle = 1;
      if (k <= 0) {
        if (!s.ballOnRoof && this.t > 3) return 'fail';
        dribbleControl(s, c, normalize(flat(sub(s.theirGoal, s.ball))), 1100);
        c.throttle = clamp(c.throttle + p.shift, -1, 1);
        return;
      }
      if (k === 1 && !s.onGround) return 'fail';
      if (k <= p.hold) { c.jump = true; c.pitch = p.p1; c.yaw = p.y1; c.roll = p.r1; }
      else if (k <= p.hold + p.wait) { c.pitch = p.p2; c.yaw = p.y2; c.roll = p.r2; }
      else if (k === p.hold + p.wait + 1) {
        if (s.onGround || !s.canFlip) return 'fail';
        c.jump = true; c.pitch = p.dp; c.yaw = p.dy;
        if (stats) stats.flicks = (stats.flicks || 0) + 1;
      } else if (k <= p.hold + p.wait + 1 + p.keep) { c.pitch = p.kp; c.yaw = p.ky; c.roll = p.kr; }
      else if (k > p.hold + p.wait + 30) recover(s, c);
      if (k > p.hold + p.wait + 80 || (k > p.hold + p.wait + 20 && s.onGround)) return 'done';
    }
  }

  // Air dribble: jump the ball off the roof and keep it just ahead of the nose with boost. Pushing against the front
  // of the car is the only contact that boost can sustain (thrust points along the nose), so the car stays
  // `dF` behind the ball along the push direction, climbing toward height zT, then pushes it at the goal inside
  // `finish`. p: hold, boostAt, p1, tw, p2, b2, el, kz, zT, dF, dz, kp, kd, ff, gain, align, minA, finish, aimZ, sLift,
  // sff, sdF (gains found by searching the sandbox from dribbles all over the field)
  const AIR_DRIBBLE = { hold: 13, boostAt: 14, p1: -0.79, tw: 11, p2: 0.4, b2: 0.21, el: 0.35, kz: 1.16, zT: 1113, dF: 156, dz: -53, kp: 7.8, kd: 3.3,
    ff: 77, gain: 13.2, align: 0.63, minA: 103, finish: 400, aimZ: 431, sLift: 0.13, sff: 139, sdF: 121 };

  class AirDribble {
    constructor(p) { this.name = 'air dribble'; this.p = p; this.t = 0; this.shoot = false; this.lastTouch = null; }
    step(s, c, stats) {
      const p = this.p, t = ++this.t;
      if (t === 1 && !s.ballOnRoof && s.onGround) return 'fail';
      if (t <= p.hold) { c.jump = true; c.pitch = p.p1; c.throttle = 1; c.boost = t > p.boostAt; return; }
      if (t <= p.hold + p.tw) { c.pitch = p.p2; c.boost = p.b2 > 0.5; c.throttle = 1; return; }
      const aim = [clamp(s.ball[0] * 0.3, -700, 700), s.theirGoal[1], p.aimZ];
      const g3 = sub(aim, s.ball);
      if (Math.hypot(g3[0], g3[1]) < p.finish) this.shoot = true;
      let D, ff = p.ff, dF = p.dF;
      if (!this.shoot) {
        const el = clamp(p.el + p.kz * (p.zT - s.ball[2]) / 1000, 0.15, 1.5), gd = normalize(flat(g3));
        D = normalize(add(mul(gd, Math.cos(el)), [0, 0, Math.sin(el)]));
      } else { D = normalize(add(normalize(g3), [0, 0, p.sLift])); ff = p.sff; dF = p.sdF; }
      // Air dribble bump: a defender right in the path gets bumped out of the way
      if (!this.bumpT && t % 6 === 0) {
        for (const other of s.world.cars) {
          if (other === s.car || other.team === s.car.team || other.isDemoed) continue;
          const rel = sub(uu(other.body.pos), s.pos), d = norm(rel);
          if (d < 700 && d > 150 && dot(normalize(rel), normalize(s.vel)) > 0.7) { this.bumpT = 30; this.bumpCar = other; if (stats) stats.bump = true; break; }
        }
      }
      if (this.bumpT > 0) {
        this.bumpT--;
        const op = add(uu(this.bumpCar.body.pos), mul(uu(this.bumpCar.body.linVel), 0.15));
        applyThrust(s, mul(normalize(sub(op, s.pos)), 1000), c, [0, 0, 1], 0);
        return;
      }
      const P = sub(s.ball, add(mul(D, dF), [0, 0, p.dz]));
      const a = add(add(mul(sub(P, s.pos), p.kp), mul(sub(s.ballVel, s.vel), p.kd)), add(mul(D, ff), [0, 0, G]));
      const dir = normalize(a);
      orient(s, dir, [0, 0, 1], c, p.gain);
      c.boost = s.boost > 0 && dot(s.f, dir) > p.align && norm(a) > p.minA;
      c.throttle = clamp(dot(a, s.f) / 66, -1, 1);
      const air = !s.onGround && s.dist < 300 && s.ball[2] > 200;
      if (air) { this.lastAir = t; if (stats) stats.airTicks = (stats.airTicks || 0) + 1; }
      if (t - (this.lastAir || 0) > 90 && t > 60) return t > 150 ? 'done' : 'fail';
      if (s.onGround && t > 60 && s.pos[2] < 60) return t > 150 ? 'done' : 'fail';
      // hand the ball over to the next trick (e.g. a flip reset) while still carrying it
      if (p.handoff && t >= p.handoff && air && s.ball[2] > s.pos[2] + 60) return 'done';
      if (t > 1100) return 'done';
    }
  }

  // Where a fast aerial off the ground leaves the car (measured: jump held 22 ticks, 3 released, second jump)
  const JUMP_T = 0.25, JUMP_DV = 610, JUMP_DZ = 110;
  function airborneStart(s) {
    if (!s.onGround) return { s, t: 0 };
    // the nose tips up while jumping, so later turns start from there
    const f = normalize(add(s.f, mul(s.u, 0.8)));
    return { s: Object.assign({}, s, { pos: add(s.pos, mul(s.u, JUMP_DZ)), vel: add(flat(s.vel), mul(s.u, JUMP_DV)), f }), t: JUMP_T };
  }

  // Seconds to swing the nose onto a direction (rough fit of the air-control PD)
  const rotTime = (s, dir) => 0.08 + 0.62 * Math.acos(clamp(dot(s.f, dir), -1, 1)) / Math.PI;

  // Thrust to be at P after T seconds when the nose first has to turn onto it and the last `coast` seconds have none
  function thrustPlan(s, P, T, coast) {
    coast = Math.min(coast || 0, T * 0.9);
    const disp = sub(sub(P, s.pos), add(mul(s.vel, T), [0, 0, -0.5 * G * T * T]));
    let a = mul(disp, 1 / Math.max(0.0004, (T - coast) * (T - coast) / 2 + (T - coast) * coast));
    for (let i = 0; i < 2; i++) {
      const tau = Math.max(T - coast - rotTime(s, normalize(a)), 0.02);
      a = mul(disp, 1 / (tau * tau / 2 + tau * coast));
    }
    return a;
  }

  // Fast aerial off the ground: first jump held, a short release, then the second jump; returns true when done.
  // A jump only registers with the wheels down, so after a landing it waits for a couple of settled ticks first.
  function fastAerial(m, s, c, pitch) {
    c.throttle = 1;
    if (!m.jt) {
      m.settled = s.onGround ? (m.settled || 0) + 1 : 0;
      if (m.settled < 3) { m.waitT = (m.waitT || 0) + 1; recover(s, c); c.throttle = 1; return false; }
    }
    m.jt = (m.jt || 0) + 1;
    c.boost = m.jt > 2;
    if (m.jt <= 22) { c.jump = true; c.pitch = pitch; }
    else if (m.jt <= 25) { c.jump = false; c.pitch = pitch * 0.7; }
    else if (m.jt === 26) { c.jump = true; c.pitch = 0; }
    else return true;
    return false;
  }

  // While no aerial plan works yet: drive toward where the ball will be, then try again next tick
  function waitForPlan(m, s, c, maxTicks) {
    m.waited = (m.waited || 0) + 1;
    if (!s.onGround || m.waited > maxTicks) return 'fail';
    const T = clamp((fallTime(s.ball, s.ballVel, 400) || 0.8), 0.3, 2);
    const b = ballistic(s.ball, s.ballVel, T).pos;
    const spot = [clamp(b[0], -3800, 3800), clamp(b[1], -4800, 4800), 0];
    driveTo(s, spot, c, Math.min(2300, norm(flat(sub(spot, s.pos))) / T));
    c.boost = false;
  }

  // Fly so the wheels land on the ball (a flip reset), then shoot with the refreshed flip.
  // The wheels' suspension rays reach about 25 uu below the car's origin and the hitbox bottom is just above it,
  // so the ball has to arrive centred under the wheelbase (8.75 uu ahead of the origin) with ~0-10 uu of slack.
  // p: elev (contact direction below the ball, radians from horizontal), azim (around the ball from the car's
  //    side), turn (seconds coasting while the wheels turn to the ball), later (extra seconds), gap, jp (jump pitch),
  //    push (closing speed kept during the turn), shootGap, flipDist
  class FlipReset {
    constructor(p) { this.name = 'flip reset'; this.p = p; this.t = 0; this.phase = 'plan'; this.flipAt = 0; }
    plan(s) {
      const p = this.p, a0 = airborneStart(s);
      const side = normalize(flat(sub(s.pos, s.ball)));
      const ca = Math.cos(p.azim), sa = Math.sin(p.azim);
      const h = [side[0] * ca - side[1] * sa, side[0] * sa + side[1] * ca, 0];
      const n = normalize(add(mul(h, Math.cos(p.elev)), [0, 0, -Math.sin(p.elev)]));
      let easiest = null;
      for (let T = a0.t + 0.3; T <= 2.8; T += 0.04) {
        const bt = ballistic(s.ball, s.ballVel, T);
        if (bt.pos[2] < 250 || bt.pos[2] > 1900 || !inArena(bt.pos, 200)) continue;
        const P = add(bt.pos, mul(n, BALL_R + p.gap));
        const need = norm(thrustPlan(a0.s, P, T - a0.t, p.turn));
        if (!easiest || need < easiest.need) easiest = { T, need };
        if (need < p.acc * BOOST_AIR) { easiest = { T, need }; break; }
      }
      // `force`: go for the least demanding contact even if the estimate says it's out of reach (the sandbox decides)
      if (!easiest || (easiest.need >= p.acc * BOOST_AIR && !(p.force && easiest.need < 2.5 * BOOST_AIR))) return false;
      this.T = easiest.T + p.later;
      this.n = n;
      this.t0 = this.t;
      return true;
    }
    target(s, left) {
      const bt = ballistic(s.ball, s.ballVel, Math.max(left, 0));
      // centre the wheelbase: the car's forward at contact is roughly its current forward
      const fw = normalize(sub(s.f, mul(this.n, dot(s.f, this.n))));
      return sub(add(bt.pos, mul(this.n, BALL_R + this.p.gap)), mul(fw, 8.75));
    }
    step(s, c, stats, events) {
      this.t++;
      const p = this.p;
      if (this.phase === 'plan') {
        if (!this.plan(s)) {
          if (s.onGround) return waitForPlan(this, s, c, this.p.wait || 150);
          // In the air (e.g. out of an air dribble): bump the ball up off the nose to open a gap, then drift facing
          // it until a contact plan works
          this.airWait = (this.airWait || 0) + 1;
          const toB = normalize(sub(s.ball, s.pos));
          orient(s, toB, [0, 0, 1], c, 10);
          if (this.airWait <= (this.p.popT || 0) && s.dist < (this.p.sep || 330)) c.boost = s.boost > 0 && dot(s.f, toB) > 0.8;
          return this.airWait > (this.p.airWait || 70) ? 'fail' : undefined;
        }
        this.phase = s.onGround ? 'jump' : 'fly';
      }
      if (events && events.some(e => e.type === 'flipReset' && e.car === s.index) && (this.phase === 'fly' || this.phase === 'turn')) {
        if (stats) stats.resets = (stats.resets || 0) + 1;
        this.phase = 'shoot';
        this.shootT = 0;
      }
      const left = this.T - (this.t - this.t0) * TICK;
      if (this.phase === 'jump') {
        if (fastAerial(this, s, c, p.jp)) this.phase = 'fly';
        else if ((this.jt > 20 && s.onGround) || this.waitT > 60) return 'fail';
        return;
      }
      if (this.phase === 'fly' || this.phase === 'turn') {
        c.jump = false;
        const P = this.target(s, left);
        if (left > p.turn && this.phase === 'fly') {
          const a = thrustPlan(s, P, left, p.turn);
          if (norm(a) > 150) applyThrust(s, a, c, this.n, 150);
          else this.wheelsTo(s, c);
        } else {
          this.phase = 'turn';
          this.wheelsTo(s, c);
          const a = thrustFor(s, P, Math.max(left, 0.03), 0);
          c.boost = s.boost > 0 && dot(s.f, normalize(a)) > 0.9 && norm(a) > p.push;
          c.throttle = clamp(dot(a, s.f) / 66, -1, 1);
        }
        if (left < -0.3 || (s.onGround && this.t > 40)) return 'fail';
        return;
      }
      if (this.phase === 'shoot') {
        // Hit the ball toward goal with the refreshed flip
        this.shootT++;
        const aimPt = p.shootAt === 'backboard' ? [s.ball[0] * 0.4, s.sign * 5120, 1300] : s.theirGoal;
        const toGoal = normalize(sub(aimPt, s.ball));
        const T = clamp(s.dist / 1400, 0.12, 1.2);
        const bt = ballistic(s.ball, s.ballVel, T);
        const P = sub(bt.pos, mul(toGoal, BALL_R + p.shootGap));
        applyThrust(s, thrustFor(s, P, T, 0), c, [0, 0, 1], 250);
        if (this.shootT > 10 && s.dist < p.flipDist && s.canFlip && dot(normalize(sub(s.ball, s.pos)), toGoal) > 0.2) {
          dodgeToward(s, normalize(sub(s.ball, s.pos)), c);
          this.phase = 'after';
          this.flipAt = this.t;
          if (stats) stats.resetShot = true;
        }
        if (this.shootT > 240 || (s.onGround && s.pos[2] < 60 && this.shootT > 20)) return 'done';
        return;
      }
      c.jump = false;
      if (this.t - this.flipAt > 30) recover(s, c);
      return this.t - this.flipAt > 70 || (s.onGround && this.t - this.flipAt > 10) ? 'done' : undefined;
    }
    // Underside to the ball: roof away from it, keeping the nose where it is as much as possible
    wheelsTo(s, c) {
      const away = normalize(sub(s.pos, s.ball));
      let fwd = sub(s.f, mul(away, dot(s.f, away)));
      if (norm(fwd) < 0.2) fwd = sub(s.u, mul(away, dot(s.u, away)));
      orient(s, normalize(fwd), away, c, this.p.gain || 12);
    }
  }

  // Aerial hit toward a target (goal or backboard), optionally with a dodge at contact. p: gap, turn, dodge, later
  class AerialShot {
    constructor(p, target, name) { this.name = name || 'aerial'; this.p = p; this.target = target; this.t = 0; this.phase = 'plan'; }
    plan(s) {
      const p = this.p, a0 = airborneStart(s);
      let easiest = null;
      for (let T = a0.t + 0.3; T <= 2.8; T += 0.05) {
        const bt = ballistic(s.ball, s.ballVel, T);
        if (bt.pos[2] < 200 || bt.pos[2] > 1900 || !inArena(bt.pos, 150)) continue;
        // a double tap's first touch needs room in front of the backboard for the rebound
        if (this.target === 'backboard' && Math.abs(bt.pos[1]) > (p.maxY || 4000)) continue;
        const aim = normalize(sub(this.aimAt(s), bt.pos));
        const P = sub(bt.pos, mul(aim, BALL_R + p.gap));
        const need = norm(thrustPlan(a0.s, P, T - a0.t, p.turn));
        if (need < (p.acc || 0.9) * BOOST_AIR) { easiest = { T, need }; break; }
        if (!easiest || need < easiest.need) easiest = { T, need };
      }
      if (!easiest || (easiest.need >= (p.acc || 0.9) * BOOST_AIR && !(p.force && easiest.need < 2.5 * BOOST_AIR))) return false;
      this.T = easiest.T + p.later;
      this.t0 = this.t;
      return true;
    }
    aimAt(s) { return this.target === 'backboard' ? [s.ball[0] * 0.4, s.sign * 5120, 1250] : s.theirGoal; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (this.phase === 'plan') {
        if (!this.plan(s)) return s.onGround ? waitForPlan(this, s, c, 150) : 'fail';
        this.phase = s.onGround ? 'jump' : 'fly';
        this.touch = s.car.lastBallTouchTick;
      }
      if (this.phase === 'jump') {
        if (fastAerial(this, s, c, 0.7)) this.phase = 'fly';
        return;
      }
      if (this.phase === 'fly') {
        c.jump = false;
        const left = this.T - (this.t - this.t0) * TICK;
        const bt = ballistic(s.ball, s.ballVel, Math.max(left, 0));
        const aim = normalize(sub(this.aimAt(s), bt.pos));
        const P = sub(bt.pos, mul(aim, BALL_R + p.gap));
        if (left > p.turn) applyThrust(s, thrustPlan(s, P, left, p.turn), c, [0, 0, 1], 200);
        else if (p.part === 'roof') {
          // skim: graze the ball with the roof, nose along the aim line
          const toB = normalize(sub(s.ball, s.pos));
          const fwd = normalize(sub(aim, mul(toB, dot(aim, toB))));
          orient(s, norm(fwd) > 0.1 ? fwd : s.f, toB, c, 12);
          const a = thrustFor(s, P, Math.max(left, 0.05), 0);
          c.boost = s.boost > 0 && dot(s.f, normalize(a)) > 0.7 && norm(a) > 300;
        } else {
          orient(s, normalize(sub(s.ball, s.pos)), [0, 0, 1], c);
          const a = thrustFor(s, P, Math.max(left, 0.05), 0);
          c.boost = s.boost > 0 && dot(s.f, normalize(a)) > 0.8 && norm(a) > 300;
          if (p.dodge && s.canFlip && s.dist < p.dodgeDist) { dodgeToward(s, normalize(sub(s.ball, s.pos)), c); this.phase = 'after'; this.flipAt = this.t; }
        }
        if (s.car.lastBallTouchTick !== this.touch && this.phase === 'fly') { this.phase = 'after'; this.flipAt = this.t; }
        if (left < -0.4) return 'fail';
        return;
      }
      c.jump = false;
      if (stats) stats.aerialTouch = true;
      recover(s, c);
      return this.t - this.flipAt > 40 || s.onGround ? 'done' : undefined;
    }
  }

  // Double tap: first touch into the backboard, then read the rebound and hit it again
  class DoubleTap {
    constructor(p) { this.name = 'double tap'; this.p = p; this.first = new AerialShot(p, 'backboard', 'double tap'); this.t = 0; }
    step(s, c, stats) {
      this.t++;
      if (!this.second) {
        const r = this.first.step(s, c, null);
        if (r === 'fail') return 'fail';
        if (this.first.phase === 'after') {
          c.jump = false;
          // Find the rebound in the sandbox: the ball coming back out after the wall
          const path = Sim.predictBall(s.world, 2.2, 2);
          const bounce = path.findIndex(b => b.vel[1] * s.sign < -100 && Math.abs(b.pos[1]) > 4300);
          if (bounce < 0) return this.t > 400 ? 'fail' : undefined;
          this.second = new Rebound(this.p, path.slice(bounce));
          if (stats) stats.firstTap = true;
        }
        return;
      }
      return this.second.step(s, c, stats);
    }
  }

  // Aerial to a point on a precomputed ball path (walls included) and dodge into it toward goal
  class Rebound {
    constructor(p, path) { this.p = p; this.path = path; this.t = 0; }
    step(s, c, stats) {
      this.t++;
      if (this.t === 1) this.touch = s.car.lastBallTouchTick;
      if (s.car.lastBallTouchTick !== this.touch && !this.hitAt) { this.hitAt = this.t; if (stats) stats.secondTap = true; }
      if (this.hitAt) { recover(s, c); return this.t - this.hitAt > 40 || s.onGround ? 'done' : undefined; }
      const T = this.t * TICK;
      // Commit to the easiest intercept on the rebound path (re-checked every 20 ticks)
      if (!this.target || this.t % 20 === 0) {
        let best = null;
        for (const b of this.path) {
          const left = b.t - T;
          if (left < 0.15 || b.pos[2] < 120) continue;
          const aim = normalize(sub(s.theirGoal, b.pos));
          const P = sub(b.pos, mul(aim, BALL_R + (this.p.gap2 || 40)));
          const need = norm(thrustPlan(s, P, left, 0.05));
          if (need < 0.85 * BOOST_AIR) { best = { b, P, need }; break; }
          if (!best || need < best.need) best = { b, P, need };
        }
        this.target = best;
      }
      if (!this.target || this.target.b.t - T < -0.2) { recover(s, c); return this.t > 240 || s.onGround ? 'done' : undefined; }
      const left = Math.max(this.target.b.t - T, 0.03);
      applyThrust(s, thrustPlan(s, this.target.P, left, 0.05), c, [0, 0, 1], 120);
      if (left < 0.12) orient(s, normalize(sub(s.ball, s.pos)), [0, 0, 1], c);
      if (s.dist < 230 && s.canFlip) dodgeToward(s, normalize(sub(s.ball, s.pos)), c);
      if (s.onGround) return 'done';
    }
  }

  // Pop the ball high off the roof and land under it (a setup for flip resets): a timed input program found in the
  // sandbox (pre ticks of dribble with a throttle shift, jump held `hold` ticks with pitch p1 / boost b1, `wait` ticks of
  // p2 / b2, then a second jump or dodge (dj, dp, dy) and a wheels-down landing)
  const POP = { pre: 17, shift: 0.38, thr: 1, hold: 16, p1: 0.45, b1: 1, wait: 18, p2: -1, b2: 1, dj: 1, dp: -0.44, dy: 0.06, thr2: 1 };

  class Pop {
    constructor(p) { this.name = 'pop'; this.p = p; this.t = 0; }
    step(s, c) {
      const p = this.p, t = ++this.t, k = t - p.pre;
      c.throttle = p.thr;
      if (k <= 0) {
        if (!s.ballOnRoof && t === 1) return 'fail';
        dribbleControl(s, c, normalize(flat(sub(s.theirGoal, s.ball))), 1000);
        c.throttle = clamp(c.throttle + p.shift, -1, 1);
        return;
      }
      if (k === 1 && !s.onGround) return 'fail';
      if (k <= p.hold) { c.jump = true; c.pitch = p.p1; c.boost = p.b1 > 0.5; }
      else if (k <= p.hold + p.wait) { c.pitch = p.p2; c.boost = p.b2 > 0.5; }
      else if (k === p.hold + p.wait + 1) { c.jump = p.dj > 0.5; c.pitch = p.dp; c.yaw = p.dy; }
      else { recover(s, c); c.throttle = p.thr2; }
      if (p.air && k >= p.hold + p.wait + p.air) return s.onGround ? 'fail' : 'done';
      if (k > p.hold + p.wait + 20 && s.onGround && s.u[2] > 0.8) return s.ball[2] > 350 || s.ballVel[2] > 300 ? 'done' : 'fail';
      if (t > 360) return 'fail';
    }
  }

  // Ceiling shot: drive up the nearest side wall onto the ceiling, drive to above where the ball is going, drop off
  // when a fall from here meets it, then dodge into it toward goal. Uses a sandbox prediction of the ball.
  // p: side (+1/-1 wall), lead (seconds of path to consider), slack (uu), gap
  class CeilingShot {
    constructor(p) { this.name = 'ceiling shot'; this.p = p; this.t = 0; this.phase = 'wall'; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (!this.path || (this.t % 60 === 0 && this.phase !== 'fall')) {
        this.path = Sim.predictBall(s.world, 6, 4);
        this.pathT = this.t;
      }
      const now = (this.t - this.pathT) * TICK;
      const future = this.path.filter(b => b.t > now + 0.2 && b.pos[2] > 700 && b.pos[2] < 1800);
      if (!future.length && this.phase !== 'fall' && this.phase !== 'after') return this.t > 60 ? 'fail' : undefined;
      const wallX = p.side * 4096;
      const onCeiling = s.onGround && s.u[2] < -0.7, onWall = s.onGround && Math.abs(s.u[0]) > 0.7;
      if (this.phase === 'wall') {
        const goal = future[0];
        if (onCeiling) this.phase = 'ceiling';
        else if (onWall) { driveTo(s, [wallX, s.pos[1] + (goal.pos[1] - s.pos[1]) * 0.5, 2044], c, 2000); c.handbrake = false; c.throttle = Math.max(c.throttle, 0.5); }
        else driveTo(s, [wallX, s.pos[1] + (goal.pos[1] - s.pos[1]) * 0.4, 0], c, 2300);
        if (!s.onGround && this.t > 30) return 'fail';
        return this.t > 600 ? 'fail' : undefined;
      }
      if (this.phase === 'ceiling') {
        if (!s.onGround) { this.phase = 'fall'; return; }
        // Drop when falling from here lands on the ball's path
        let best = null;
        for (const b of future) {
          const fallT = Math.sqrt(Math.max(0, 2 * (s.pos[2] - b.pos[2] - p.gap) / G));
          const land = add(flat(s.pos), mul(flat(s.vel), fallT));
          const miss = norm(sub(land, flat(b.pos))), dt = b.t - now - fallT;
          if (!best || Math.abs(dt) * 1000 + miss < best.err) best = { b, dt, miss, err: Math.abs(dt) * 1000 + miss };
        }
        if (best && Math.abs(best.dt) < 0.05 && best.miss < p.slack) { this.phase = 'drop'; this.dropT = 0; if (stats) stats.ceiling = true; return; }
        const target = best ? best.b.pos : future[0].pos;
        driveTo(s, [target[0], target[1], 2044], c, clamp(norm(flat(sub(target, s.pos))) / Math.max(0.3, best ? best.b.t - now - 0.5 : 1), 300, 2000));
        // stay stuck to the ceiling: no powerslides, keep some throttle
        c.handbrake = false;
        c.throttle = Math.max(c.throttle, 0.35);
        return this.t > 900 ? 'fail' : undefined;
      }
      if (this.phase === 'drop') {
        this.dropT++;
        c.throttle = 0;
        if (!s.onGround || this.dropT > 10) this.phase = 'fall';
        return;
      }
      if (this.phase === 'fall') {
        const toGoal = normalize(sub(s.theirGoal, s.ball));
        const T = clamp(s.dist / 1300, 0.1, 1.2);
        const P = sub(ballistic(s.ball, s.ballVel, T).pos, mul(toGoal, BALL_R + 50));
        applyThrust(s, thrustFor(s, P, T, 0), c, [0, 0, 1], 250);
        if (s.dist < 240 && s.canFlip) { dodgeToward(s, normalize(sub(s.ball, s.pos)), c); this.phase = 'after'; this.at = this.t; if (stats) stats.ceilingShot = true; }
        return (s.onGround && s.pos[2] < 60) || this.t > 1200 ? 'fail' : undefined;
      }
      recover(s, c);
      return this.t - this.at > 50 || s.onGround ? 'done' : undefined;
    }
  }

  // Ground power shot ("boom") or hook shot: drive through the ball at speed along a line bent by `angle` from the
  // aim line (a hook hits it with the corner / side), jumping at `jumpDist` and dodging `delay` ticks later
  // toward the ball. p: angle, jumpDist, delay, hold, side
  class GroundShot {
    constructor(p) { this.name = Math.abs(p.angle) > 0.3 ? 'hook shot' : 'power shot'; this.p = p; this.t = 0; this.phase = 'drive'; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (this.phase === 'drive') {
        if (!s.onGround) return this.t > 30 ? 'fail' : undefined;
        const T = clamp(s.dist / Math.max(1200, s.fwdSpeed + 400), 0.05, 2);
        const B = ballistic(s.ball, s.ballVel, T);
        if (B.pos[2] > 260) return this.t > 240 ? 'fail' : (driveTo(s, flat(B.pos), c, 1400), undefined);
        const aim = normalize(flat(sub([clamp(B.pos[0], -700, 700), s.theirGoal[1], 0], B.pos)));
        const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
        const line = [aim[0] * ca - aim[1] * sa, aim[0] * sa + aim[1] * ca, 0];
        const contact = sub(flat(B.pos), mul(line, BALL_R + 70));
        const way = norm(flat(sub(contact, s.pos))) > 500 ? sub(contact, mul(line, 350)) : contact;
        driveTo(s, around(s, way, s.ball, 200), c, 2300);
        c.boost = c.boost || (s.fwdSpeed < 2250 && dot(normalize(flat(sub(way, s.pos))), s.f) > 0.9);
        if (s.dist < p.jumpDist && dot(normalize(flat(s.toBall)), s.f) > 0.5 && s.ball[2] < 250) { this.phase = 'jump'; this.jt = 0; }
        return this.t > 400 ? 'fail' : undefined;
      }
      if (this.phase === 'jump') {
        this.jt++;
        c.throttle = 1;
        if (this.jt <= p.hold) c.jump = true;
        else if (this.jt === p.hold + p.delay) {
          const d = normalize(sub(s.ball, s.pos));
          dodgeToward(s, normalize(add(d, mul(s.r, p.side))), c);
          this.phase = 'after'; this.at = this.t;
          if (stats) stats.shot = true;
        }
        return;
      }
      if (this.t - this.at > 25) recover(s, c);
      return this.t - this.at > 70 || (s.onGround && this.t - this.at > 15) ? 'done' : undefined;
    }
  }

  // Zen touch: fly up to a ball that's coming through the air and meet it softly on the nose (matching its speed), then
  // carry it as an air dribble. p: T bias, gap, the air dribble gains
  class ZenTouch {
    constructor(p) { this.name = 'zen touch'; this.p = p; this.t = 0; this.phase = 'plan'; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (this.phase === 'plan') {
        const a0 = airborneStart(s);
        for (let T = a0.t + 0.35; T <= 2.6; T += 0.05) {
          const B = ballistic(s.ball, s.ballVel, T);
          if (B.pos[2] < 300 || B.pos[2] > 1700 || !inArena(B.pos, 300)) continue;
          const P = sub(B.pos, [0, 0, BALL_R + p.gap]);
          if (norm(thrustPlan(a0.s, P, T - a0.t, 0.1)) < 0.85 * BOOST_AIR) { this.T = T + p.later; this.t0 = this.t; break; }
        }
        if (!this.T) return s.onGround ? waitForPlan(this, s, c, 150) : 'fail';
        this.phase = s.onGround ? 'jump' : 'fly';
      }
      if (this.phase === 'jump') { if (fastAerial(this, s, c, 0.6)) this.phase = 'fly'; return; }
      if (this.phase === 'fly') {
        const left = this.T - (this.t - this.t0) * TICK;
        const B = ballistic(s.ball, s.ballVel, Math.max(left, 0));
        // come in under the ball matching its velocity: aim below it, lead by the velocity difference
        const P = sub(add(B.pos, mul(sub(s.ballVel, s.vel), p.match * Math.max(left, 0))), [0, 0, BALL_R + p.gap]);
        applyThrust(s, thrustPlan(s, P, Math.max(left, 0.05), 0.05), c, [0, 0, 1], 150);
        if (s.dist < p.handoff || left < -0.2) {
          if (s.dist > 420) return 'fail';
          this.phase = 'carry';
          this.carry = new AirDribble(Object.assign({}, AIR_DRIBBLE, p.air, { hold: 0, tw: 0 }));
          if (stats) stats.zen = true;
        }
        return s.onGround && this.t > 40 ? 'fail' : undefined;
      }
      return this.carry.step(s, c, stats);
    }
  }

  // Wall air dribble: drive up the side wall under the ball, jump off the wall with it and carry it as an air dribble.
  // p: speed, jumpDist, hold, pitch, boostAt
  class WallAirDribble {
    constructor(p) { this.name = 'wall air dribble'; this.p = p; this.t = 0; this.phase = 'climb'; }
    step(s, c, stats) {
      this.t++;
      const p = this.p;
      if (this.phase === 'climb') {
        const onWall = s.onGround && Math.abs(s.u[0]) > 0.6;
        const wallX = Math.sign(s.ball[0] || 1) * 4096;
        // On the wall: keep the ball just ahead and push it up the wall (aim a little under it); off it: get to the wall
        const target = onWall ? sub(s.ball, [0, 0, p.under || 60]) : [wallX, s.ball[1] - s.sign * 250, 0];
        driveTo(s, target, c, onWall ? Math.min(p.speed, norm(s.ballVel) + (p.push || 300)) : p.speed);
        c.handbrake = false;
        if (onWall && s.dist < p.jumpDist && s.ball[2] > (p.jumpZ || 0) && dot(s.toBall, s.f) > -40) { this.phase = 'jump'; this.jt = 0; }
        if ((!s.onGround && this.t > 20) || this.t > 600) return 'fail';
        return;
      }
      if (this.phase === 'jump') {
        this.jt++;
        c.throttle = 1;
        c.jump = this.jt <= p.hold;
        c.pitch = p.pitch;
        c.boost = this.jt > p.boostAt;
        if (this.jt > p.hold + 2) {
          this.phase = 'carry';
          this.carry = new AirDribble(Object.assign({}, AIR_DRIBBLE, { hold: 0, tw: 0 }));
          if (stats) stats.wall = true;
        }
        return;
      }
      return this.carry.step(s, c, stats);
    }
  }

  // Pinch: hit a ball sitting against the side wall hard into the wall so it squirts out fast. p: into, jump
  class Pinch {
    constructor(p) { this.name = 'pinch'; this.p = p; this.t = 0; }
    step(s, c, stats) {
      this.t++;
      const p = this.p, wallDir = [Math.sign(s.ball[0] || 1), 0, 0];
      if (!this.hit) {
        const aim = add(s.ball, mul(wallDir, p.into));
        driveTo(s, add(aim, mul(flat(s.ballVel), 0.15)), c, 2300);
        c.boost = s.onGround && dot(normalize(flat(sub(aim, s.pos))), s.f) > 0.85;
        c.handbrake = false;
        if (p.jump && s.dist < p.jump && s.onGround) c.jump = true;
        if (s.car.lastBallTouchTick === s.tick - 1) { this.hit = this.t; if (stats) stats.pinch = true; }
        return this.t > 360 ? 'fail' : undefined;
      }
      recover(s, c);
      return this.t - this.hit > 60 ? 'done' : undefined;
    }
  }

  // Squishy save: get in front of a shot, jump and backflip upside down so the roof and wheels block the ball.
  // p: lead (ticks driving at the ball first), speed, hold, wait, cancel (pitch held after the flip)
  class SquishySave {
    constructor(p) { this.name = 'squishy save'; this.p = p; this.t = 0; }
    step(s, c, stats) {
      const p = this.p, t = ++this.t;
      if (t === 1 && !s.onGround) return 'fail';
      if (t <= p.lead) { driveTo(s, flat(s.ball), c, p.speed); return; }
      const k = t - p.lead;
      if (k <= p.hold) c.jump = true;
      else if (k <= p.hold + p.wait) c.pitch = 0;
      else if (k === p.hold + p.wait + 1) { c.jump = true; c.pitch = 1; }
      else if (k <= p.hold + p.wait + 40) c.pitch = p.cancel;
      else recover(s, c);
      if (stats && s.car.lastBallTouchTick === s.tick - 1) stats.saveTouch = true;
      return k > p.hold + p.wait + 90 || (s.onGround && k > p.hold + p.wait + 20) ? 'done' : undefined;
    }
  }

  // After a shot into the backboard: read the rebound in the sandbox and hit it again (the end of a signature shot)
  class Followup {
    constructor(p) { this.name = 'double touch'; this.p = p; this.t = 0; }
    step(s, c, stats) {
      this.t++;
      if (!this.inner) {
        const path = Sim.predictBall(s.world, 2.4, 2);
        const i = path.findIndex(b => b.vel[1] * s.sign < -100 && Math.abs(b.pos[1]) > 4300);
        if (i < 0) { recover(s, c); return this.t > 120 ? 'fail' : undefined; }
        this.inner = new Rebound(this.p, path.slice(i));
      }
      const r = this.inner.step(s, c, stats);
      if (stats && stats.secondTap) stats.signature = true;
      return r;
    }
  }

  // 50/50: dodge straight into a ball an opponent is about to hit
  class FiftyFifty {
    constructor() { this.name = '50/50'; this.t = 0; }
    step(s, c) {
      this.t++;
      c.throttle = 1;
      if (this.t <= 3) c.jump = true;
      else if (this.t === 5) dodgeToward(s, normalize(sub(s.ball, s.pos)), c);
      else if (this.t > 30) recover(s, c);
      return this.t > 60 || (s.onGround && this.t > 25) ? 'done' : undefined;
    }
  }

  // ---------------- movement tech ----------------
  // Half flip: backflip, cancel it halfway and air roll upright, ending up turned around (inputs found in the sandbox:
  // from reversing at 0-700 uu/s it ends wheels down, facing the other way at 1500-2000 uu/s)
  const HALF_FLIP = { h1: 9, w1: 1, cancel: 30, cp: 0.5, rd: 40, cp2: -1, roll: -1, yaw: 1, boostAt: 49 };
  class HalfFlip {
    constructor(s) { this.name = 'half flip'; this.t = 0; this.dir = dot(s.toBall, s.r) > 0 ? -1 : 1; }
    step(s, c) {
      const p = HALF_FLIP, t = ++this.t;
      c.throttle = -1;
      if (t <= p.h1) c.jump = true;
      else if (t <= p.h1 + p.w1) { }
      else if (t === p.h1 + p.w1 + 1) { c.jump = true; c.pitch = 1; }
      else if (t <= p.h1 + p.w1 + 1 + p.cancel) c.pitch = p.cp;
      else if (t <= p.h1 + p.w1 + 1 + p.cancel + p.rd) { c.pitch = p.cp2; c.roll = p.roll * this.dir; c.yaw = p.yaw * this.dir; c.throttle = 1; }
      else { recover(s, c); c.throttle = 1; }
      if (t > p.boostAt) c.boost = dot(s.f, normalize(flat(s.toBall))) > 0.7;
      if ((t > 90 && s.onGround) || t > 200) return 'done';
    }
  }

  // Speed flip: a diagonal dodge cancelled straight away with an air roll so the car lands wheels down on its line
  // (sandbox-tuned). It doesn't beat full boost in this physics, so Trilo uses it to gain speed when low on boost.
  const SPEED_FLIP = { pre: 7, st: -0.02, h: 1, w: 0, dy: 0.71, k: 27, cp: -0.85, roll: -0.33, yaw: -0.3 };
  class SpeedFlip {
    constructor(s) { this.name = 'speed flip'; this.t = 0; this.dir = dot(s.toBall, s.r) > 0 ? 1 : -1; }
    step(s, c) {
      const p = SPEED_FLIP, t = ++this.t, d = this.dir;
      c.throttle = 1; c.boost = s.boost > 30;
      if (t <= p.pre) c.steer = p.st * d;
      else if (t <= p.pre + p.h) c.jump = true;
      else if (t <= p.pre + p.h + p.w) { }
      else if (t === p.pre + p.h + p.w + 1) { c.jump = true; c.pitch = -1; c.yaw = p.dy * d; }
      else if (t <= p.pre + p.h + p.w + 1 + p.k) { c.pitch = p.cp; c.roll = p.roll * d; c.yaw = p.yaw * d; }
      else recover(s, c);
      if ((t > 45 && s.onGround) || t > 160) return 'done';
    }
  }

  class WaveDash {
    constructor(s) { this.name = 'wave dash'; this.t = 0; this.dir = normalize(flat(s.toBall)); }
    step(s, c) {
      this.t++;
      c.throttle = 1;
      if (this.t === 1) { dodgeToward(s, this.dir, c); c.handbrake = true; return; }
      c.handbrake = this.t < 12;
      return this.t > 15 ? 'done' : undefined;
    }
  }

  class WallDash {
    constructor() { this.name = 'wall dash'; this.t = 0; }
    step(s, c) {
      this.t++;
      c.throttle = 1;
      if (this.t <= 3) c.jump = true;
      else if (this.t <= 6) c.jump = false;
      else if (this.t === 7) { c.jump = true; c.pitch = -1; }
      return this.t > 36 ? 'done' : undefined;
    }
  }

  // ---------------- planning ----------------
  // A candidate is { make: () => mechanic, chain?: [() => mechanic...], style } played out in the sandbox.

  const rollBox = new Sim.Sandbox(), leadBox = new Sim.Sandbox();
  const budget = { tick: -1, ms: 0 };
  const BUDGET_MS = 5;

  // Play a candidate forward from `box`'s state; returns stats and a score
  function rollout(startWorld, cand, maxTicks, startBox) {
    startBox = startBox || { others: [] };
    rollBox.syncFrom(startWorld, 0, startWorld.cars.map((c, i) => i).slice(1));
    rollBox.others = startBox.others;
    const w = rollBox.world, stats = { ticks: 0, touches: 0, path: [] };
    let mech = cand.make(), queue = (cand.chain || []).slice(), status, t = 0, ended = -1, goal = null;
    const team = w.cars[0].team;
    for (; t < maxTicks; t++) {
      const s = read(w, 0, false), c = blank();
      if (mech) {
        status = mech.step(s, c, stats, w.events);
        if (status === 'fail') { stats.failed = mech.name; mech = null; ended = t; break; }
        if (status === 'done') { mech = queue.length ? queue.shift()() : null; if (!mech) ended = t; }
      } else recover(s, c);
      rollBox.step(c);
      if (t % 4 === 0) { stats.path.push(uu(w.ball.pos)); (stats.carPath = stats.carPath || []).push(uu(w.cars[0].body.pos)); }
      if (w.events.some(e => e.type === 'ballHit' && e.car === 0)) stats.touches++;
      const scored = w.scoredGoal();
      if (scored) { goal = scored === team ? 'for' : 'against'; break; }
      if (ended >= 0 && t - ended > (cand.tail === undefined ? 150 : cand.tail)) break;
    }
    stats.ticks = ended >= 0 ? ended : t;
    stats.goal = goal;
    const ball = uu(w.ball.pos), bv = uu(w.ball.linVel), sign = team === 'blue' ? 1 : -1;
    stats.ballEnd = ball;
    stats.towardGoal = bv[1] * sign;
    stats.complete = !stats.failed && ended >= 0;
    return stats;
  }

  function scoreOf(cand, st) {
    if (st.failed) return -1000;
    if (st.goal === 'against') return -800;
    let score = cand.style || 0;
    score += (st.resets || 0) * 400 + (st.resetShot ? 100 : 0);
    score += Math.min(st.airTicks || 0, 400) * 0.8;
    score += st.caught ? 150 : 0;
    score += st.firstTap ? 150 : 0;
    score += st.secondTap ? 200 : 0;
    score += st.flicks ? 60 : 0;
    score += st.goal === 'for' ? 500 : 0;
    const sign = st.sign || 1;
    score += clamp(st.towardGoal / 20, -60, 120);
    if (!st.complete && !st.goal) score -= 50;
    if (cand.needs && !st[cand.needs]) return -500;
    return score;
  }

  // A planning job: while the car runs `lead` for `delay` ticks, candidates are played out from the state the car
  // will be in when the lead finishes; the best one starts at exactly that tick
  class PlanJob {
    constructor(world, index, lead, delay, cands, horizon) {
      this.lead = lead();
      this.delay = delay;
      this.cands = cands;
      this.horizon = horizon;
      this.results = [];
      this.age = 0;
      // Lead-in in the sandbox from the current state
      // Other cars near the action take part in the sandbox, holding their current inputs
      const ball = uu(world.ball.pos), me = uu(world.cars[index].body.pos);
      const others = world.cars.map((c, i) => i).filter(i => i !== index && !world.cars[i].isDemoed &&
        Math.min(norm(sub(uu(world.cars[i].body.pos), ball)), norm(sub(uu(world.cars[i].body.pos), me))) < 2500);
      leadBox.syncFrom(world, index, others);
      const l = lead();
      for (let i = 0; i < delay; i++) {
        const s = read(leadBox.world, 0, false), c = blank();
        if (l.step(s, c) === 'fail') { this.broken = true; break; }
        leadBox.step(c);
      }
      this.start = new Sim.Sandbox();
      this.start.syncFrom(leadBox.world, 0, others.map((_, k) => k + 1));
      this.start.others = leadBox.others;
      this.predictedBall = uu(this.start.world.ball.pos);
      this.predictedCar = uu(this.start.world.cars[0].body.pos);
    }
    work(world) {
      if (budget.tick !== world.tickCount) { budget.tick = world.tickCount; budget.ms = 0; }
      while (this.results.length < this.cands.length && budget.ms < BUDGET_MS) {
        const t0 = performance.now();
        const cand = this.cands[this.results.length];
        const st = rollout(this.start.world, cand, cand.horizon || this.horizon, this.start);
        st.sign = world.cars[0] ? 1 : 1;
        this.results.push({ cand, st, score: scoreOf(cand, st) });
        budget.ms += performance.now() - t0;
      }
    }
    get finished() { return this.results.length >= this.cands.length; }
    // Best candidate, with a bonus for tricks not used lately so Trilo mixes it up
    best(minScore, recent) {
      let best = null, bestV = -Infinity;
      for (const r of this.results) {
        if (r.score <= minScore || (r.cand.style < 0 && r.score < 60)) continue;
        const name = r.cand.name, uses = recent ? recent.filter(n => n === name).length : 0;
        const v = r.score + (uses === 0 ? 120 : -50 * uses);
        if (v > bestV) { bestV = v; best = r; }
      }
      return best;
    }
  }

  // ---------------- candidates per situation ----------------
  function shuffle(a, r) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // The tuned flicks plus a few nudged variants of each; the sandbox picks what works from the real state
  function jitter(p, r, amount) {
    const q = Object.assign({}, p);
    for (const k of ['pre', 'hold', 'wait', 'keep']) q[k] = Math.max(k === 'hold' ? 1 : 0, Math.round(p[k] + (r() - 0.5) * 8 * amount));
    for (const k of ['shift', 'p1', 'y1', 'r1', 'p2', 'y2', 'r2', 'kp', 'ky', 'kr']) q[k] = clamp(p[k] + (r() - 0.5) * 0.5 * amount, -1, 1);
    return q;
  }

  function flickCands(r) {
    const out = [];
    const put = (kind, p, style) => out.push({ name: kind + ' flick', make: () => new Flick(kind, p), style, horizon: 320, needs: 'flicks' });
    for (let i = 0; i < 3; i++) {
      const a = i ? i * 0.6 : 0;
      put('front', jitter(FLICKS.front, r, a), 40);
      put('musty', jitter(FLICKS.musty, r, a), 90);
      put('45', jitter(FLICKS['45'], r, a), 60);
      put('45', jitter(mirror(FLICKS['45']), r, a), 60);
    }
    return out;
  }

  function airDribbleCands(r) {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const k = i * 0.12, q = Object.assign({}, AIR_DRIBBLE);
      if (i) {
        for (const key of ['hold', 'boostAt', 'tw']) q[key] = Math.max(1, Math.round(q[key] + (r() - 0.5) * 10 * k));
        for (const key of ['p1', 'p2']) q[key] = clamp(q[key] + (r() - 0.5) * 1.2 * k, -1, 1);
        q.el = clamp(q.el + (r() - 0.5) * 0.6 * k, 0.15, 1.4); q.zT = q.zT + (r() - 0.5) * 900 * k; q.dF = q.dF + (r() - 0.5) * 60 * k;
        q.kp = q.kp * (1 + (r() - 0.5) * k); q.kd = q.kd * (1 + (r() - 0.5) * k); q.finish = Math.max(300, q.finish + r() * 2500 * k);
      }
      out.push({ name: 'air dribble', make: () => new AirDribble(q), style: 150, horizon: 1100, needs: 'airTicks' });
    }
    return out;
  }

  // Flip reset settings found by searching the sandbox over lobbed balls (resets in 6 of 8 test lobs)
  const RESET = { elev: 0.69, azim: -0.36, turn: 0.37, later: 0.13, gap: 7.2, acc: 0.94, jp: 0.9, push: 639, gain: 8, shootGap: 35, flipDist: 210 };

  // Air dribble up, then turn the wheels onto the ball for a flip reset and shoot
  function airResetCands(r) {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const q = Object.assign({}, AIR_DRIBBLE, { handoff: 90 + Math.floor(r() * 150) });
      const p = Object.assign({}, RESET, { elev: 0.9 + r() * 0.65, azim: (r() - 0.5) * 3, turn: 0.15 + r() * 0.3, later: r() * 0.2, gap: r() * 10, acc: 0.95, wait: 0, popT: 10 + Math.floor(r() * 30), sep: 300 + r() * 150, airWait: 150 });
      out.push({ name: 'air dribble flip reset', make: () => new AirDribble(q), chain: [() => new FlipReset(p)], style: 260, horizon: 1100 });
    }
    return out;
  }

  // Moves found by searching the sandbox over many random situations (js/trilo-moves.js): each entry is a set of
  // parameters that worked somewhere, so from a real state a few of them usually work again
  function libraryCands(r, kind, n) {
    const lib = (Game.TriloMoves && Game.TriloMoves[kind === 'signature' ? 'airReset' : kind]) || [];
    const out = [];
    // pick entries without repeats, favouring the ones that work most often
    const pool = lib.slice();
    for (let i = 0; i < Math.min(n, lib.length); i++) {
      let x = r() * pool.reduce((a, e) => a + (e.rate || 0.1), 0), j = 0;
      while (j < pool.length - 1 && (x -= pool[j].rate || 0.1) > 0) j++;
      const e = pool.splice(j, 1)[0];
      if (kind === 'popReset') out.push({ name: 'pop + flip reset', make: () => new Pop(e.pop), chain: [() => new FlipReset(e.reset)], style: 280, horizon: 1000, needs: 'resets' });
      else if (kind === 'signature') {
        const q = Object.assign({}, AIR_DRIBBLE, e.air), rs = Object.assign({}, e.reset, { shootAt: 'backboard' }), fp = { gap: 40 };
        out.push({ name: 'signature shot', make: () => new AirDribble(q), chain: [() => new FlipReset(rs), () => new Followup(fp)], style: 380, horizon: 1600, needs: 'signature' });
      } else if (kind === 'airReset') {
        const q = Object.assign({}, AIR_DRIBBLE, e.air);
        out.push({ name: 'air dribble flip reset', make: () => new AirDribble(q), chain: [() => new FlipReset(e.reset)], style: 300, horizon: 1300, needs: 'resets' });
      } else if (kind === 'wall') out.push({ name: 'wall air dribble', make: () => new WallAirDribble(e.p), style: 170, horizon: 1000, needs: 'wall' });
      else if (kind === 'zen') out.push({ name: 'zen touch', make: () => new ZenTouch(Object.assign({ air: {} }, e.p)), style: 160, horizon: 1000, needs: 'zen' });
      else if (kind === 'doubleTap') out.push({ name: 'double tap', make: () => new DoubleTap(e.p), style: 200, horizon: 800, needs: 'secondTap' });
      else if (kind === 'catch') out.push({ name: 'catch', make: () => new Catch(e.p), style: 300, horizon: 650, tail: 0, needs: 'caught' });
      else out.push({ name: 'flip reset', make: () => new FlipReset(e.reset), style: 250, horizon: 900, needs: 'resets' });
    }
    return out;
  }

  function randomResetCands(r, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = { elev: -0.3 + r() * 1.87, azim: (r() - 0.5) * 6.28, turn: 0.1 + r() * 0.6, later: -0.1 + r() * 0.6, gap: -8 + r() * 23, acc: 0.4 + r() * 0.7, jp: r(), push: r() * 1000,
        gain: 5 + r() * 11, shootGap: 30 + r() * 40, flipDist: 190 + r() * 80, wait: Math.floor(r() * 150), force: r() < 0.6 };
      out.push({ name: 'flip reset', make: () => new FlipReset(p), style: 250, horizon: 900, needs: 'resets' });
    }
    return out;
  }

  function wallCands(r, n) {
    const out = libraryCands(r, 'wall', n);
    if (out.length) return out;
    for (let i = 0; i < n; i++) {
      const p = { speed: 1200 + r() * 1000, jumpDist: 180 + r() * 200, hold: 4 + Math.floor(r() * 18), pitch: (r() - 0.3) * 1.4, boostAt: Math.floor(r() * 10) };
      out.push({ name: 'wall air dribble', make: () => new WallAirDribble(p), style: 170, horizon: 1000, needs: 'wall' });
    }
    return out;
  }

  function pinchCands(r) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = { into: 60 + r() * 300, jump: r() < 0.4 ? 150 + r() * 150 : 0 };
      out.push({ name: 'pinch', make: () => new Pinch(p), style: 60, horizon: 480, tail: 200, needs: 'pinch' });
    }
    return out;
  }

  function resetCands(r, pop) {
    const out = [];
    for (let i = 0; i < 10; i++) {
      const k = i === 0 ? 0 : 0.2 + i * 0.08;
      const p = Object.assign({}, RESET, {
        elev: clamp(RESET.elev + (r() - 0.5) * 1.2 * k, 0, 1.5), azim: RESET.azim + (r() - 0.5) * 2 * k, turn: clamp(RESET.turn + (r() - 0.5) * 0.4 * k, 0.12, 0.8),
        later: clamp(RESET.later + (r() - 0.5) * 0.4 * k, -0.1, 0.5), gap: clamp(RESET.gap + (r() - 0.5) * 12 * k, -8, 20), acc: clamp(RESET.acc + (r() - 0.5) * 0.4 * k, 0.3, 0.95)
      });
      const cand = { name: 'flip reset', make: () => new FlipReset(p), style: 200, horizon: 720 };
      if (pop) {
        const pp = i === 0 ? POP : Object.assign({}, POP, { pre: Math.max(0, POP.pre + Math.round((r() - 0.5) * 12)), hold: Math.max(4, POP.hold + Math.round((r() - 0.5) * 8)), wait: Math.max(0, POP.wait + Math.round((r() - 0.5) * 10)), p1: clamp(POP.p1 + (r() - 0.5) * 0.6, -1, 1), dp: clamp(POP.dp + (r() - 0.5) * 0.6, -1, 1) });
        cand.make = () => new Pop(pp); cand.chain = [() => new FlipReset(p)]; cand.name = 'pop + flip reset';
      }
      out.push(cand);
    }
    return out;
  }

  function shotCands(r) {
    const out = [];
    for (const angle of [0, 0.5, -0.5, 0.9, -0.9]) {
      const p = { angle: angle + (r() - 0.5) * 0.2, jumpDist: 230 + r() * 200, delay: 3 + Math.floor(r() * 6), hold: 4 + Math.floor(r() * 8), side: (r() - 0.5) * 0.6 };
      out.push({ name: Math.abs(angle) > 0.3 ? 'hook shot' : 'power shot', make: () => new GroundShot(p), style: -150, horizon: 480, tail: 200, needs: 'shot' });
    }
    return out;
  }

  // Catches: bump the ball at 300-900 uu/s relative so it hops, then slide under it. Meeting a rolling ball head-on
  // works best (the bump takes the pace off it); a slow ball can be taken from anywhere.
  function catchCands(r) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const p = { dv: 400 + r() * 450, back: 300 + r() * 500, lead: 10 + r() * 25, steer: 2 + r() * 3, hop: 115, scoop: 0.3, brake: 1800 + r() * 900,
        slide: 5 + r() * 8, headOn: i % 2 === 0 };
      out.push({ name: 'catch', make: () => new Catch(p), style: 300, horizon: 650, tail: 0, needs: 'caught' });
    }
    return out;
  }

  // ---------------- the bot ----------------
  class TriloBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Trilo';
      this.nexto = new Game.BotsNecto.NextoBot(world, carIndex);
      this.log = [];
      this.recent = [];
      this.seed = 1234 + carIndex * 7777;
      this.reset();
    }

    get ready() { return this.nexto.ready; }

    reset() {
      this.nexto.reset();
      this.mech = null;
      this.job = null;
      this.chain = [];
      this.path = null;
      this.cooldown = 60;
      this.carryT = 0;
      this.minCarry = 90;
      this.lastJump = false;
      this.airTicks = 0;
    }

    note(text) {
      this.log.push(text);
      if (this.log.length > 60) this.log.shift();
    }

    random() { return rng(this.seed++); }

    // path: the ball's positions from the sandbox run (every 4 ticks) to check the real game against
    start(mech, chain, path) {
      this.mech = mech;
      this.chain = chain || [];
      this.path = path || null;
      this.carPath = null;
      this.planT = 0;
      this.note(mech.name);
    }

    // Trilo goes for the ball when it gets there clearly before anyone else (always when alone)
    hasPossession(s) {
      if (!s.opps.length && !s.mates.length) return true;
      const eta = (pos, vel) => {
        const d = sub(s.ball, pos), dist = norm(d);
        return dist / Math.max(1400, dot(vel, normalize(d)) + 600);
      };
      const mine = eta(s.pos, s.vel);
      const theirs = Math.min(Infinity, ...s.opps.map(o => eta(o.pos, o.vel)));
      const mates = Math.min(Infinity, ...s.mates.map(o => eta(o.pos, o.vel)));
      return mine < theirs - 0.25 && mine <= mates + 0.05;
    }

    situation(s) {
      if (!s.onGround || s.u[2] < 0.7) return null;
      if (s.ballOnRoof) return 'roof';
      if (s.ball[2] < 160 && Math.abs(s.ballVel[2]) < 150) return 'ground';
      return 'air';
    }

    // Candidate plans for the situation and the lead-in the car drives while they're checked
    makeJob(s, sit) {
      const r = this.random();
      const nearWall = Math.abs(s.ball[0]) > 3100;
      if (sit === 'defend') {
        const cands = [];
        for (let i = 0; i < 8; i++) {
          const p = { lead: Math.floor(r() * 60), speed: 600 + r() * 1700, hold: 3 + Math.floor(r() * 20), wait: Math.floor(r() * 15), cancel: (r() - 0.5) * 2 };
          cands.push({ name: 'squishy save', make: () => new SquishySave(p), style: 150, horizon: 420, tail: 150 });
        }
        for (let i = 0; i < 4; i++) {
          const p = { gap: 40 + r() * 60, turn: 0.15, later: r() * 0.15, dodge: r() < 0.5, dodgeDist: 200 + r() * 60 };
          cands.push({ name: 'aerial', make: () => new AerialShot(p, 'goal'), style: 60, horizon: 450 });
        }
        cands.push(...shotCands(r).slice(0, 3));
        return new PlanJob(this.world, this.index, () => new Approach(), 8, shuffle(cands, r), 450);
      }
      if (sit === 'roof') {
        const cands = flickCands(r);
        if (s.boost > 25) cands.push(...airDribbleCands(r).slice(0, 4));
        if (s.boost > 35) cands.push(...libraryCands(r, 'popReset', 8), ...libraryCands(r, 'airReset', 7), ...libraryCands(r, 'signature', 3));
        if (nearWall && s.boost > 30) cands.push(...wallCands(r, 3));
        return new PlanJob(this.world, this.index, () => new Dribble({ speed: 1100 }), 60, shuffle(cands, r), 1100);
      }
      if (sit === 'ground') {
        // catches (the start of every dribble freestyle) are checked first, shots only as a fallback
        const cands = shuffle(catchCands(r), r);
        if (nearWall) cands.push(...pinchCands(r), ...(s.boost > 30 ? wallCands(r, 3) : []));
        cands.push(...shotCands(r));
        return new PlanJob(this.world, this.index, () => new Approach(), 30, cands, 700);
      }
      const cands = catchCands(r).slice(0, 3);
      if (s.boost > 25) {
        cands.push(...libraryCands(r, 'lobReset', 10), ...randomResetCands(r, 6));
        for (let i = 0; i < 3; i++) {
          const p = { gap: 40 + r() * 40, turn: 0.15, later: r() * 0.2, dodge: true, dodgeDist: 200 + r() * 60 };
          const redirect = norm(flat(s.ballVel)) > 1000;
          cands.push({ name: redirect ? 'redirect' : s.ball[2] < 500 ? 'doink' : 'aerial', make: () => new AerialShot(p, 'goal'), style: 60, horizon: 500, needs: 'aerialTouch' });
        }
        const taps = libraryCands(r, 'doubleTap', 4), zens = libraryCands(r, 'zen', 4);
        cands.push(...taps, ...zens);
        if (!taps.length) for (let i = 0; i < 3; i++) {
          const p = { gap: 40 + r() * 40, turn: 0.15, later: r() * 0.2, dodge: true, dodgeDist: 200 + r() * 60 };
          cands.push({ name: 'double tap', make: () => new DoubleTap(p), style: 200, horizon: 800, needs: 'secondTap' });
        }
        if (!zens.length) for (let i = 0; i < 2; i++) {
          const p = { gap: 10 + r() * 30, later: r() * 0.2, match: r() * 0.6, handoff: 200 + r() * 120, air: {} };
          cands.push({ name: 'zen touch', make: () => new ZenTouch(p), style: 160, horizon: 1000, needs: 'zen' });
        }
        // Psycho: skim a ball coming off our own backboard with the roof and send it the length of the field
        if (s.ball[1] * s.sign < -3800 && s.ball[2] > 500) {
          for (let i = 0; i < 3; i++) {
            const p = { gap: r() * 30, turn: 0.2 + r() * 0.3, later: r() * 0.2, part: 'roof' };
            cands.push({ name: 'psycho', make: () => new AerialShot(p, 'goal', 'psycho'), style: 200, horizon: 600, needs: 'aerialTouch' });
          }
        }
        if (nearWall) cands.push(...wallCands(r, 3));
        if (nearWall || s.ballVel[2] > 900) {
          cands.push({ name: 'ceiling shot', make: () => new CeilingShot({ side: Math.sign(s.ball[0] || 1), slack: 250, gap: 60 }), style: 250, horizon: 1100, needs: 'ceilingShot' });
        }
      }
      return new PlanJob(this.world, this.index, () => new Approach(), 24, shuffle(cands, r), 900);
    }

    // A shot heading into our net that Trilo is best placed to stop: {t, pos} or null (checked every few ticks)
    threat(s) {
      if (s.tick % 8 !== 0) return this.lastThreat || null;
      this.lastThreat = null;
      if (s.ball[1] * s.sign > 0 || s.ballVel[1] * s.sign > -300) return null;
      const path = Sim.predictBall(this.world, 2.5, 4);
      const hit = path.find(b => b.pos[1] * s.sign < -5000 && Math.abs(b.pos[0]) < 950 && b.pos[2] < 700);
      if (!hit) return null;
      const mine = norm(sub(hit.pos, s.pos));
      if (s.mates.some(m => norm(sub(hit.pos, m.pos)) < mine - 300) || mine > 2600) return null;
      return (this.lastThreat = hit);
    }

    tick() {
      const base = this.nexto.tick(), w = this.world;
      if (!this.ready) return base;
      const s = read(w, this.index, true);
      this.airTicks = s.onGround ? 0 : this.airTicks + 1;
      this.carryT = s.ballOnRoof ? this.carryT + 1 : 0;
      if (w.kickoffPause || s.car.isDemoed) { this.mech = null; this.job = null; this.cooldown = 30; return this.finish(base); }
      let out = null;
      try {
        out = this.think(s, base);
      } catch (e) {
        if (!this.warned) { this.warned = true; console.warn('Trilo error', e); }
        this.mech = null; this.job = null;
      }
      return this.finish(out || base);
    }

    think(s, base) {
      const w = this.world;
      if (this.cooldown > 0) this.cooldown--;

      // Planning: drive the lead-in while candidates play out in the sandbox
      if (this.job) {
        const job = this.job, c = blank();
        job.work(w);
        const st = job.lead.step(s, c);
        job.age++;
        if (st === 'fail') { this.job = null; return base; }
        if (job.age >= job.delay) {
          this.job = null;
          this.lastJob = job.results.map(x => [x.cand.name, Math.round(x.score), x.st.failed || '', x.st.resets || 0, x.st.goal || '']);
          const best = !job.broken && job.best(-100, this.recent);
          if (best && this.closeTo(s, job)) {
            this.start(best.cand.make(), best.cand.chain && best.cand.chain.slice(), best.st.path);
            this.carPath = best.st.carPath; this.carWarned = false;
            if (best.cand.name !== 'catch') { this.recent.push(best.cand.name); if (this.recent.length > 4) this.recent.shift(); }
            this.note('picked ' + best.cand.name + ' (' + Math.round(best.score) + ', ' + job.results.length + '/' + job.cands.length + ' checked)');
          } else if (job.lead.name === 'dribble') {
            this.start(new Dribble({ speed: 1100, ticks: 20 }));
          }
        }
        return c;
      }

      // 50/50: an opponent is about to hit the ball we're right next to
      if (s.dist < 300 && s.onGround && s.ball[2] < 250 && (!this.mech || ['dribble', 'catch'].includes(this.mech.name))) {
        const o = s.opps.find(o => norm(sub(o.pos, s.ball)) < 450 && dot(o.vel, normalize(sub(s.ball, o.pos))) > 700);
        if (o) { this.job = null; this.start(new FiftyFifty()); }
      }

      // A running mechanic
      if (this.mech) {
        const c = blank();
        const st = this.mech.step(s, c, null, w.events);
        this.planT++;
        if (this.carPath && (this.planT - 1) % 4 === 0) {
          const cw = this.carPath[(this.planT - 1) / 4];
          if (cw && norm(sub(s.pos, cw)) > 40 && !this.carWarned) { this.carWarned = true; this.note('car off plan at ' + this.planT + ': ' + Math.round(norm(sub(s.pos, cw)))); }
        }
        if (this.path && (this.planT - 1) % 4 === 0) {
          const want = this.path[(this.planT - 1) / 4];
          if (want && norm(sub(s.ball, want)) > 60) {
            this.note(this.mech.name + ': ball moved off plan, re-planning');
            this.mech = null; this.path = null; this.cooldown = 0;
            return c;
          }
        }
        if (st === 'done' || st === 'fail') {
          if (st === 'fail') this.note(this.mech.name + ' failed');
          const next = st === 'done' && this.chain.length ? this.chain.shift()() : null;
          this.mech = next;
          if (next) this.note(next.name);
          else { this.path = null; this.cooldown = st === 'fail' ? 20 : 0; }
        }
        return c;
      }

      if (this.cooldown <= 0 && s.onGround && s.u[2] > 0.7 && this.threat(s)) {
        this.job = this.makeJob(s, 'defend');
        return this.think(s, base);
      }
      if (this.cooldown <= 0 && this.hasPossession(s) && s.dist < 3000) {
        const sit = this.situation(s);
        if (sit === 'roof' && this.carryT < this.minCarry) {
          // Carry it for a bit before the next trick
          this.start(new Dribble({ speed: 1100, ticks: 12 }));
          return this.think(s, base);
        }
        if (sit) {
          if (sit !== 'roof') this.minCarry = 20 + Math.floor(this.random()() * 80);
          this.job = this.makeJob(s, sit);
          return this.think(s, base);
        }
      }
      return this.movementTech(s, base);
    }

    // The lead-in ended where the sandbox said it would (nobody interfered)
    closeTo(s, job) {
      return norm(sub(s.ball, job.predictedBall)) < 40 && norm(sub(s.pos, job.predictedCar)) < 40;
    }

    movementTech(s, base) {
      const c = Object.assign({}, base);
      if (s.onGround && s.u[2] > 0.9 && s.fwdSpeed < -500 && base.throttle < 0 && dot(normalize(flat(s.toBall)), s.f) < -0.7 && s.dist > 900) {
        this.start(new HalfFlip(s));
        return this.think(s, base);
      }
      if (s.onGround && s.u[2] > 0.9 && s.fwdSpeed > 300 && s.fwdSpeed < 1300 && base.throttle > 0.5 && s.boost < 25 && s.dist > 2500 && dot(normalize(flat(s.toBall)), s.f) > 0.97 && this.cooldown <= 0) {
        this.start(new SpeedFlip(s));
        this.cooldown = 240;
        return this.think(s, base);
      }
      // Wave dash: dodge just before the wheels touch down
      if (!s.onGround && this.airTicks > 40 && s.vel[2] < -250 && s.pos[2] > 20 && s.pos[2] < 55 && s.u[2] > 0.92 && s.canFlip && !this.lastJump) {
        const dir = normalize(flat(s.toBall));
        if (dot(dir, s.f) > 0.3) {
          const m = new WaveDash(s);
          // Pogo: the same dodge into the floor bounces the car back up at a ball that's above it
          if (s.ball[2] > 300 && norm(flat(s.toBall)) < 700) m.name = 'pogo';
          this.start(m);
          return this.think(s, base);
        }
      }
      if (s.onGround && s.u[2] < 0.3 && Math.abs(s.u[2]) < 0.3 && s.pos[2] > 300 && base.throttle > 0 && s.speed < 1500 && this.cooldown <= 0) {
        this.cooldown = 90;
        this.start(new WallDash());
        return this.think(s, base);
      }
      return c;
    }

    finish(c) {
      this.lastJump = !!c.jump;
      return c;
    }
  }

  // Heads for a spot behind the ball, facing the other goal, while plans are checked
  class Approach {
    constructor() { this.name = 'approach'; this.t = 0; }
    step(s, c) {
      this.t++;
      const goalDir = normalize(flat(sub(s.theirGoal, s.ball)));
      const target = sub(add(s.ball, mul(flat(s.ballVel), 0.3)), mul(goalDir, 400));
      driveTo(s, around(s, target, s.ball, 260), c, 1400);
    }
  }

  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'nexto') + 1, 0,
    { id: 'trilo', name: 'Trilo', desc: "A freestyler with Nexto's speed and aggression. Every time it gets the ball it goes for a freestyle, testing each idea in its own copy of the physics first: catches into dribbles, front, 45 and musty flicks, air dribbles, flip resets, double taps and ceiling shots, plus wave dashes, half flips and speed flips. Also plays in free play, so you can watch it show off.",
      modes: ['freeplay', '1v1', '2v2', '3v3'], make: (w, i) => new TriloBot(w, i), load: () => Game.BotsNecto.loadModel('nexto') });

  Game.BotsTrilo = {
    TriloBot, read, rollout, scoreOf, PlanJob, rng,
    mechanics: { Dribble, Catch, Flick, Pop, Rebound, GroundShot, ZenTouch, WallAirDribble, Pinch, SquishySave, Followup, FiftyFifty, AirDribble, FlipReset, AerialShot, DoubleTap, CeilingShot, HalfFlip, SpeedFlip, WaveDash, WallDash, Approach },
    cands: { flickCands, airDribbleCands, airResetCands, resetCands, catchCands, shotCands },
    helpers: { ballistic, thrustFor, applyThrust, orient, dodgeToward, driveTo, dribbleControl, recover, onRoof }
  };
})();
