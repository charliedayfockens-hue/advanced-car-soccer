// Botimus Prime & Bumblebee, part 1: game info, ball prediction, time estimates and driving/jumping mechanics.
// Port of Darxeal's BotimusPrime (RLBotPack, MIT) tools/ and maneuvers/ to this game. The original leans on
// RLUtilities (GPL) for its Drive/Dodge/Wavedash/Reorient/Aerial mechanics, ball and car simulation; those are
// NOT ported: this file has its own versions built on this game's RocketSim port.
// Vectors are [x, y, z] arrays in uu (RLBot axes), controls use RLBot's Input fields.
window.Game = window.Game || {};

Game.Botimus = (function () {
  const BT = Game.RL.BT_TO_UU, RL = Game.RL;
  const { Vec3 } = Game.Math;
  const Ctl = Game.BotControl;

  // ---------------- math (tools/math.py, tools/vector_math.py, RLUtilities linear_algebra) ----------------
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const clamp11 = x => clamp(x, -1, 1);
  const absClamp = (x, l) => clamp(x, -l, l);
  const sign = x => (x >= 0 ? 1 : -1);
  const nonzero = x => Math.max(x, 1e-6);
  const rangeMap = (x, a, b, c, d) => (x - a) * (d - c) / (b - a) + c;
  const vec = (x = 0, y = 0, z = 0) => [x, y, z];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const normalize = a => { const n = norm(a); return n > 1e-9 ? mul(a, 1 / n) : [0, 0, 0]; };
  const angleBetween = (a, b) => Math.acos(clamp(dot(normalize(a), normalize(b)), -1, 1));
  const pos = o => (Array.isArray(o) ? o : o.position);
  const ground = o => { const p = pos(o); return [p[0], p[1], 0]; };
  const distance = (a, b) => norm(sub(pos(a), pos(b)));
  const groundDistance = (a, b) => norm(sub(ground(a), ground(b)));
  const direction = (a, b) => normalize(sub(pos(b), pos(a)));
  const groundDirection = (a, b) => normalize(sub(ground(b), ground(a)));
  const xy = a => [a[0], a[1], 0];
  const local = (car, p) => { const d = sub(pos(p), car.position); return [dot(d, car.forward), dot(d, car.left), dot(d, car.up)]; };
  const world = (car, l) => add(car.position, add(add(mul(car.forward, l[0]), mul(car.left, l[1])), mul(car.up, l[2])));
  const angleTo = (car, target, backwards) => Math.abs(angleBetween(mul(xy(car.forward), backwards ? -1 : 1), groundDirection(car.position, target)));
  const align = (p, ball, goal) => {
    const toBall = groundDirection(p, ball);
    return Math.max(dot(toBall, groundDirection(ball, goal)), dot(toBall, groundDirection(ball, add(goal, [800, 0, 0]))), dot(toBall, groundDirection(ball, sub(goal, [800, 0, 0]))));
  };
  const nearestPoint = (p, pts) => pts.reduce((a, b) => (distance(p, b) < distance(p, a) ? b : a));
  const farthestPoint = (p, pts) => pts.reduce((a, b) => (distance(p, b) > distance(p, a) ? b : a));
  // Orientation {forward, left, up} looking along `dir` with `up` roughly up (left is the side steering turns toward)
  const lookAt = (dir, up) => {
    const f = normalize(dir), l = normalize(cross(up, f));
    return { forward: f, left: l, up: cross(f, l) };
  };
  const toVec3 = a => new Vec3(a[0], a[1], a[2]);
  const Input = () => ({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });

  // tools/arena.py
  const Arena = {
    size: [4096, 5120, 2044],
    clamp: (p, off = 0) => [absClamp(p[0], 4096 - off), absClamp(p[1], 5120 - off), p[2]],
    inside: (p, off = 0) => Math.abs(p[0]) < 4096 - off && Math.abs(p[1]) < 5120 - off
  };
  // RLUtilities Field.collide(sphere): the surface normal if anything is within `radius`, else null
  const fieldCollide = (p, radius) => (Game.Arena.sdf(p[0], p[1], p[2]) < radius ? (n => [n.x, n.y, n.z])(Game.Arena.normal(p[0], p[1], p[2])) : null);

  // ---------------- ball prediction (replaces RLUtilities Ball.step) ----------------
  // Gravity, drag and bounces off the arena's surfaces: restitution 0.6 and a tangential loss on real impacts
  const PRED_DT = 1 / 60, PRED_TIME = 6;
  function simulateBall(p, v, t0, duration) {
    const R = RL.BALL_COLLISION_RADIUS_SOCCAR, drag = Math.pow(1 - RL.BALL_DRAG, PRED_DT), out = [];
    p = p.slice(); v = v.slice();
    for (let t = PRED_DT; t <= duration + 1e-9; t += PRED_DT) {
      v[2] -= 650 * PRED_DT;
      v = mul(v, drag);
      p = add(p, mul(v, PRED_DT));
      const d = Game.Arena.sdf(p[0], p[1], p[2]);
      if (d < R) {
        const nn = Game.Arena.normal(p[0], p[1], p[2]), n = [nn.x, nn.y, nn.z];
        p = add(p, mul(n, R - d));
        const vn = dot(v, n);
        if (vn < 0) {
          const vt = sub(v, mul(n, vn));
          v = add(mul(vt, -vn > 150 ? 0.72 : 1), mul(n, -vn * 0.6));
        }
      }
      const s = norm(v);
      if (s > 6000) v = mul(v, 6000 / s);
      out.push({ position: p, velocity: v, time: t0 + t });
    }
    return out;
  }

  // ---------------- game info (tools/game_info.py) ----------------
  class Goal {
    constructor(team) {
      this.team = team;
      this.sign = 1 - 2 * team;
      this.center = [0, -this.sign * 5120, 320];
      this.l_post = [this.sign * 892, -this.sign * 5120, 0];
      this.r_post = [-this.sign * 892, -this.sign * 5120, 0];
    }
    inside(p) { return this.team === 0 ? p[1] < -5120 : p[1] > 5120; }
  }

  const infoCache = new WeakMap();
  // One per world and team, refreshed at most once per physics tick
  function gameInfo(sim, team) {
    let byTeam = infoCache.get(sim);
    if (!byTeam) infoCache.set(sim, byTeam = {});
    const info = byTeam[team] || (byTeam[team] = new GameInfo(sim, team));
    info.refresh();
    return info;
  }

  class GameInfo {
    constructor(sim, team) {
      this.sim = sim;
      this.team = team;
      this.my_goal = new Goal(team);
      this.their_goal = new Goal(1 - team);
      this.tick = -1;
      this.cars = [];
      this.ball_predictions = [];
      this.predictionTick = -1;
    }

    refresh() {
      const w = this.sim;
      if (this.tick === w.tickCount && this.cars.length === w.cars.length) return;
      this.tick = w.tickCount;
      this.time = w.tickCount / 120;
      this.time_delta = 1 / 120;
      if (this.cars.length !== w.cars.length) this.cars = w.cars.map((c, i) => ({ index: i, sim: c }));
      this.cars.forEach(c => {
        const s = c.sim, b = s.body, R = b.rot, f = R.col(0), l = R.col(1), u = R.col(2);
        c.id = s.id;
        c.team = s.team === 'orange' ? 1 : 0;
        c.position = [b.pos.x * BT, b.pos.y * BT, b.pos.z * BT];
        c.velocity = [b.linVel.x * BT, b.linVel.y * BT, b.linVel.z * BT];
        c.angular_velocity = [b.angVel.x, b.angVel.y, b.angVel.z];
        c.forward = [f.x, f.y, f.z]; c.left = [l.x, l.y, l.z]; c.up = [u.x, u.y, u.z];
        c.boost = s.state.boost;
        c.on_ground = s.state.isOnGround;
        c.demolished = !!s.isDemoed;
        c.time = this.time;
      });
      const ball = w.ball;
      this.ball = { position: [ball.pos.x * BT, ball.pos.y * BT, ball.pos.z * BT], velocity: [ball.linVel.x * BT, ball.linVel.y * BT, ball.linVel.z * BT], time: this.time };
      if (!this.pads) {
        this.pads = w.boostPads.map(p => ({ sim: p, position: [p.pos.x * BT, p.pos.y * BT, 73], isBig: p.isBig }));
        this.large_boost_pads = this.pads.filter(p => p.isBig);
        this.small_boost_pads = this.pads.filter(p => !p.isBig);
      }
      const standard = w.boostMode === 'standard';
      this.pads.forEach(p => { p.active = !standard || p.sim.isActive !== false; p.timer = standard ? p.sim.cooldown || 0 : 0; });
    }

    get_teammates(car) { return this.cars.filter(c => c.team === this.team && c.id !== car.id); }
    get_opponents() { return this.cars.filter(c => c.team !== this.team); }

    // predict_ball: shared 6 s prediction per tick, cut to the requested duration
    predict_ball(duration = 5) {
      if (this.predictionTick !== this.tick) {
        this.predictionTick = this.tick;
        this.fullPrediction = simulateBall(this.ball.position, this.ball.velocity, this.time, PRED_TIME);
      }
      const end = this.time + duration;
      this.ball_predictions = this.fullPrediction.filter(b => b.time <= end);
      this.about_to_score = this.about_to_be_scored_on = false;
      this.time_of_goal = -1;
      for (const b of this.ball_predictions) {
        if (this.my_goal.inside(b.position)) { this.about_to_be_scored_on = true; this.time_of_goal = b.time; break; }
        if (this.their_goal.inside(b.position)) { this.about_to_score = true; this.time_of_goal = b.time; break; }
      }
    }

    // Straight-line version of detect_collisions: pairs of car indices about to meet within time_limit
    detect_collisions(timeLimit = 0.2, dt = 1 / 60) {
      const out = [], steps = Math.floor(timeLimit / dt);
      for (let i = 0; i < this.cars.length; i++) {
        for (let j = i + 1; j < this.cars.length; j++) {
          const a = this.cars[i], b = this.cars[j];
          if (a.demolished || b.demolished) continue;
          for (let s = 0; s < steps; s++) {
            if (distance(add(a.position, mul(a.velocity, s * dt)), add(b.position, mul(b.velocity, s * dt))) < 150) { out.push([i, j, s * dt]); break; }
          }
        }
      }
      return out;
    }
  }

  // ---------------- time estimates (tools/intercept.py, data/acceleration_lut.py) ----------------
  const CURVATURE = [[0, 0.0069], [500, 0.00398], [1000, 0.00235], [1500, 0.001375], [1750, 0.0011], [2300, 0.00088]];
  function maxCurvature(speed) {
    speed = clamp(speed, 0, 2300);
    for (let i = 1; i < CURVATURE.length; i++) {
      if (speed <= CURVATURE[i][0]) {
        const [s0, c0] = CURVATURE[i - 1], [s1, c1] = CURVATURE[i];
        return c0 + (c1 - c0) * (speed - s0) / (s1 - s0);
      }
    }
    return 0.00088;
  }
  const turnRadius = speed => { const s = clamp(speed, 0, 2300); return 156 + 0.1 * s + 0.000069 * s * s + 0.000000164 * s ** 3 - 5.62e-11 * s ** 4; };
  const throttleAccel = v => (v < 0 ? 3500 : v < 1400 ? 1600 - 1440 * v / 1400 : v < 1410 ? 160 * (1410 - v) / 10 : 0);

  // Integrates straight-line acceleration until a distance or time limit (replaces the CSV lookup tables)
  function accelerate(speed, boost, distLimit, timeLimit = Infinity) {
    const dt = 1 / 60;
    let t = 0, d = 0;
    while (d < distLimit && t < timeLimit) {
      const a = throttleAccel(speed) + (boost ? 991.667 : 0);
      if (a <= 0 || (!boost && speed >= 1410) || speed >= 2300) break;
      speed = Math.min(speed + a * dt, boost ? 2300 : 1410);
      d += Math.max(speed, 0) * dt;
      t += dt;
      if (t > 10) break;
    }
    return { speed, time: t, distance: d, distanceReached: d >= distLimit };
  }

  function estimateTime(car, target, dd = 1) {
    const radius = 1 / maxCurvature(norm(car.velocity) + 500);
    let turning = angleBetween(mul(car.forward, dd), direction(car.position, target)) * radius / 1800;
    if (turning < 0.5) turning = 0;
    let dist = groundDistance(car, target) - 200;
    if (dist < 0) return turning;
    let speed = dot(car.velocity, car.forward) * dd, time = 0, result = null;
    if (car.boost > 0 && dd > 0) {
      result = accelerate(speed, true, dist, car.boost / 33.33);
      dist -= result.distance; time += result.time; speed = result.speed;
    }
    if (dist > 0 && speed < 1410) {
      result = accelerate(speed, false, dist);
      dist -= result.distance; time += result.time; speed = result.speed;
    }
    if (!result || !result.distanceReached) time += Math.max(dist, 0) / Math.max(speed, 300);
    return time * 1.05 + turning;
  }

  class Intercept {
    constructor(car, predictions, predicate, ignoreTimeEstimate = false, backwards = false) {
      this.car = car;
      this.ball = null;
      this.is_viable = true;
      this.predicate_later_than_time = false;
      for (let i = 0; i < predictions.length; i += 2) {
        const ball = predictions[i];
        const time = estimateTime(car, ball.position, backwards ? -1 : 1);
        if (time < ball.time - car.time || ignoreTimeEstimate) {
          if (!predicate || predicate(car, ball)) { this.ball = ball; break; }
          this.predicate_later_than_time = true;
        } else {
          this.predicate_later_than_time = false;
        }
      }
      if (!this.ball) {
        this.ball = predictions.length ? predictions[predictions.length - 1] : { position: [0, 0, 93], velocity: [0, 0, 0], time: Infinity };
        this.is_viable = false;
      }
      this.time = this.ball.time;
      this.ground_pos = ground(this.ball.position);
      this.position = this.ball.position;
    }
  }

  // ---------------- maneuvers ----------------
  class Maneuver {
    constructor(car) { this.car = car; this.controls = Input(); this.finished = false; }
    step() {}
    interruptible() { return true; }
  }

  // maneuvers/driving/drive.py
  class Drive extends Maneuver {
    constructor(car, targetPos = vec(), targetSpeed = 0, backwards = false) {
      super(car);
      this.target_pos = targetPos; this.target_speed = targetSpeed; this.backwards = backwards; this.drive_on_walls = false;
    }
    step() {
      const car = this.car, c = this.controls;
      let target = Arena.clamp(this.target_pos, 100);
      if (Math.abs(car.position[1]) > 5070 && Math.abs(car.position[0]) < 1000) {
        target = Arena.clamp(target, 200);
        target[0] = absClamp(target[0], 700);
      }
      if (!this.drive_on_walls) {
        const seam = Math.abs(car.position[1]) > 5020 ? 100 : 200;
        if (car.position[2] > seam) target = ground(car);
      }
      const lt = local(car, target);
      if (this.backwards) { lt[0] *= -1; lt[1] *= -1; }
      const phi = Math.atan2(lt[1], lt[0]);
      c.steer = clamp11(2.5 * phi);
      c.handbrake = Math.abs(phi) > 1.5 && car.position[2] < 300 && (groundDistance(car, target) < 3500 || Math.abs(car.position[0]) > 3500) &&
        dot(normalize(car.velocity), car.forward) > 0.85;
      let vf = dot(car.velocity, car.forward);
      if (this.backwards) vf *= -1;
      if (vf < this.target_speed) {
        c.throttle = 1;
        c.boost = this.target_speed > 1400 && vf < 2250 && this.target_speed - vf > 50;
      } else {
        if (vf - this.target_speed > 400) c.throttle = -1;
        else if (vf - this.target_speed > 100) c.throttle = car.up[2] > 0.85 ? 0 : 0.01;
        c.boost = false;
      }
      if (this.backwards) { c.throttle *= -1; c.steer *= -1; c.boost = false; c.handbrake = false; }
      if (Math.abs(phi) > 0.3) c.boost = false;
      c.yaw = c.steer; c.pitch = 0; c.roll = 0; c.jump = false;
      if (distance(car, this.target_pos) < 100) this.finished = true;
    }
  }

  class Stop extends Maneuver {
    step() {
      const vf = dot(this.car.forward, this.car.velocity);
      this.controls.throttle = vf > 100 ? -1 : vf < -100 ? 1 : 0;
      if (Math.abs(vf) <= 100) this.finished = true;
    }
  }

  // RLUtilities Reorient equivalent: PD controller toward an orientation {forward, left, up}
  class Reorient extends Maneuver {
    constructor(car) { super(car); this.target_orientation = lookAt(car.forward, [0, 0, 1]); }
    step() {
      const o = this.target_orientation;
      Ctl.reorient(this.car.sim, toVec3(o.forward), toVec3(o.up), this.controls, 5);
    }
  }

  // maneuvers/jumps/jump.py
  class Jump {
    constructor(duration) { this.duration = duration; this.controls = Input(); this.timer = 0; this.counter = 0; this.finished = false; }
    interruptible() { return false; }
    step(dt) {
      this.controls.jump = this.timer < this.duration;
      if (!this.controls.jump) this.counter += 1;
      this.timer += dt;
      if (this.counter >= 2) this.finished = true;
      return this.finished;
    }
  }

  // RLUtilities Dodge equivalent: hold jump, short delay, then flip toward `direction` (world xy) or `target`
  class Dodge extends Maneuver {
    constructor(car) { super(car); this.jump_duration = 0.1; this.delay = 0.05; this.direction = null; this.target = null; this.timer = 0; this.dodged = false; }
    interruptible() { return false; }
    step(dt) {
      const car = this.car, c = Input(), at = this.jump_duration + this.delay;
      if (this.timer < this.jump_duration) c.jump = true;
      else if (this.timer < at) c.jump = false;
      else if (!this.dodged) {
        const d = this.direction ? [this.direction[0], this.direction[1], 0] : this.target ? xy(sub(this.target, car.position)) : car.forward;
        const l = [dot(d, car.forward), dot(d, car.left)];
        const k = Math.max(Math.abs(l[0]), Math.abs(l[1]), 1e-6);
        c.jump = true; c.pitch = -l[0] / k; c.yaw = l[1] / k;
        this.dodged = true;
      }
      this.controls = c;
      this.timer += dt;
      this.finished = (this.dodged && this.timer > at + 0.35 && car.on_ground) || this.timer > at + 1.4;
    }
  }

  // RLUtilities Wavedash equivalent: small jump, nose up, dodge just before the wheels touch down
  class Wavedash extends Maneuver {
    constructor(car) { super(car); this.direction = null; this.timer = 0; this.dodged = false; }
    interruptible() { return false; }
    step(dt) {
      const car = this.car, c = Input();
      if (this.timer < 0.08) c.jump = true;
      else if (!this.dodged) {
        const f = normalize(add(xy(car.forward), [0, 0, 0.35]));
        Ctl.reorient(car.sim, toVec3(f), new Vec3(0, 0, 1), c, 5);
        if (this.timer > 0.2 && car.position[2] < 55 && car.velocity[2] < 0) {
          const d = this.direction || car.forward, l = [dot(d, car.forward), dot(d, car.left)];
          const k = Math.max(Math.abs(l[0]), Math.abs(l[1]), 1e-6);
          c.jump = true; c.pitch = -l[0] / k; c.yaw = l[1] / k; c.roll = 0;
          this.dodged = true;
        }
      }
      c.throttle = 1;
      this.controls = c;
      this.timer += dt;
      this.finished = (this.dodged && this.timer > 0.4 && car.on_ground) || this.timer > 1.6;
    }
  }

  // maneuvers/jumps/air_dodge.py
  class AirDodge extends Maneuver {
    constructor(car, jumpDuration = 0, target = null) {
      super(car);
      this.target = target;
      this.jump = new Jump(jumpDuration);
      if (jumpDuration <= 0) this.jump.finished = true;
      this.counter = 0; this.state_timer = 0;
    }
    interruptible() { return false; }
    step(dt) {
      const car = this.car, recovery = this.target ? 0.4 : 0;
      if (!this.jump.finished) {
        this.jump.step(dt);
        this.controls = Object.assign(Input(), this.jump.controls);
      } else {
        const c = this.controls;
        if (this.counter === 0) {
          if (!this.target) { c.roll = c.pitch = c.yaw = 0; }
          else {
            const tl = local(car, this.target); tl[2] = 0;
            const td = normalize(tl);
            c.roll = 0; c.pitch = -td[0]; c.yaw = clamp11(sign(car.up[2]) * td[1]);
            if (tl[0] > 0 && dot(car.velocity, car.forward) > 500) { c.pitch *= 0.8; c.yaw = clamp11(c.yaw * 5); }
          }
        } else if (this.counter === 2) c.jump = true;
        else if (this.counter >= 4) { c.roll = c.pitch = c.yaw = 0; c.jump = false; }
        this.counter += 1;
        this.state_timer += dt;
      }
      this.finished = this.jump.finished && this.state_timer > recovery && this.counter >= 6;
    }
  }

  // maneuvers/jumps/aim_dodge.py
  class AimDodge extends AirDodge {
    constructor(car, duration, target) { super(car, duration, target); this.reorient = new Reorient(car); }
    step(dt) {
      super.step(dt);
      if (!this.jump.finished && !this.car.on_ground) {
        const td = direction(this.car, add(this.target, [0, 0, 200]));
        const up = mul(td, -1); up[2] = 1;
        this.reorient.target_orientation = lookAt(td, normalize(up));
        this.reorient.step(dt);
        this.controls.pitch = this.reorient.controls.pitch;
        this.controls.yaw = this.reorient.controls.yaw;
        this.controls.roll = this.reorient.controls.roll;
      }
    }
  }

  // maneuvers/jumps/half_flip.py
  class HalfFlip {
    constructor(car, useBoost = false) {
      this.car = car; this.use_boost = useBoost; this.controls = Input();
      this.dodge = new Dodge(car);
      this.dodge.jump_duration = 0.12;
      this.dodge.direction = mul(car.forward, -1);
      this.s = 0.95 * sign(dot(car.angular_velocity, car.up) + 0.01);
      this.timer = 0; this.finished = false;
    }
    interruptible() { return false; }
    step(dt) {
      this.dodge.step(dt);
      const c = this.controls = Object.assign(Input(), this.dodge.controls);
      if (this.timer > 0.5 && this.timer < 0.7) { c.roll = 0; c.pitch = -1; c.yaw = 0; }
      if (this.timer > 0.7) { c.roll = this.s; c.pitch = -1; c.yaw = this.s; }
      c.boost = this.use_boost && this.timer > 0.4;
      this.timer += dt;
      this.finished = this.timer > 2 || (this.car.on_ground && this.timer > 0.5);
    }
  }

  // maneuvers/jumps/speed_flip.py
  class SpeedFlip extends Maneuver {
    constructor(car, rightHanded = true, useBoost = true) { super(car); this.direction = rightHanded ? 1 : -1; this.use_boost = useBoost; this.timer = 0; }
    interruptible() { return false; }
    step(dt) {
      const c = this.controls;
      c.throttle = 1;
      c.boost = this.use_boost && norm(this.car.velocity) < 2290;
      if (this.timer < 0.1) { c.jump = true; c.pitch = 1; }
      else if (this.timer < 0.2) { c.jump = false; c.pitch = 1; }
      else if (this.timer < 0.25) { c.jump = true; c.pitch = -1; c.roll = -0.3 * this.direction; }
      else { c.jump = false; c.pitch = 1; c.roll = -this.direction; c.yaw = -this.direction; }
      this.timer += dt;
      this.finished = this.timer > 2 || (this.car.on_ground && this.timer > 0.5);
    }
  }

  // maneuvers/driving/travel.py
  class Travel extends Maneuver {
    constructor(car, target = vec(), wasteBoost = false) {
      super(car);
      this.target = Arena.clamp(ground(target), 100);
      this.waste_boost = wasteBoost;
      this.finish_distance = 500;
      this._time_on_ground = 0;
      this.driving = true;
      const fwd = estimateTime(car, this.target), back = estimateTime(car, this.target, -1) + 0.5;
      const backwards = dot(car.velocity, car.forward) < 500 && back < fwd &&
        (distance(car, this.target) > 3000 || distance(car, this.target) < 300) && car.position[2] < 200;
      this.drive = new Drive(car, this.target, 2300, backwards);
      this.action = this.drive;
    }
    interruptible() { return this.driving && this.car.on_ground; }
    step(dt) {
      const car = this.car, target = ground(this.target), speed = norm(car.velocity);
      const timeLeft = (groundDistance(car, target) - this.finish_distance) / Math.max(speed + 500, 1400);
      const fwdSpeed = dot(car.forward, car.velocity);
      if (this.driving && car.on_ground) {
        this.action.target_pos = target;
        this._time_on_ground += dt;
        if (this._time_on_ground > 0.2 && car.position[2] < 200 && speed < 2000 && angleTo(car, target, fwdSpeed < 0) < 0.1) {
          if (fwdSpeed > 0) {
            const boostInstead = this.waste_boost && car.boost > 20;
            if (speed > 1200 && !boostInstead) {
              if (timeLeft > 1.5) {
                const dodge = new Dodge(car);
                dodge.jump_duration = 0.07;
                dodge.direction = direction(car, target);
                this.action = dodge; this.driving = false;
              } else if (timeLeft > 1.45) {
                const wd = new Wavedash(car);
                wd.direction = direction(car, target);
                this.action = wd; this.driving = false;
              }
            }
          } else if (timeLeft > 2 && speed > 800) {
            this.action = new HalfFlip(car, this.waste_boost && timeLeft > 3);
            this.driving = false;
          }
        }
      }
      this.action.step(dt);
      this.controls = Object.assign(Input(), this.action.controls);
      if (this.driving && !car.on_ground) this.controls.boost = false;
      if (!car.on_ground) this.controls.throttle = 1;
      if (this.action.finished && !this.driving) {
        this.driving = true; this._time_on_ground = 0; this.action = this.drive; this.drive.backwards = false;
      }
      if (groundDistance(car, target) < this.finish_distance && this.driving) this.finished = true;
    }
  }

  // maneuvers/driving/arrive.py
  class Arrive extends Maneuver {
    constructor(car) {
      super(car);
      this.drive = new Drive(car);
      this.travel = new Travel(car);
      this.travel.drive.backwards = false;
      this.action = this.drive;
      this.target_direction = null; this.target = null; this.arrival_time = 0; this.backwards = false;
      this.lerp_t = 0.56; this.allow_dodges_and_wavedashes = true; this.additional_shift = 0; this.asap = false;
    }
    interruptible() { return this.action.interruptible(); }
    step(dt) {
      const car = this.car, target = this.target;
      let shifted = target, shiftedTime = this.arrival_time;
      if (this.target_direction) {
        const speed = norm(car.velocity), td = normalize(this.target_direction);
        let shift = clamp(groundDistance(car.position, target) * this.lerp_t, 0, clamp(speed, 1500, 2300) * 1.6);
        if (shift - this.additional_shift * 0.5 < turnRadius(clamp(speed, 500, 2300)) * 1.1) shift = 0;
        else shift += this.additional_shift;
        shifted = sub(target, mul(td, shift));
        shiftedTime = this.arrival_time - groundDistance(shifted, target) / clamp(speed, 500, 2300) * 1.2;
      }
      this.drive.target_pos = shifted;
      this.travel.target = shifted;
      const dist = groundDistance(car.position, shifted);
      let targetSpeed = clamp(dist / nonzero(shiftedTime - car.time), 0, 2300);
      if (targetSpeed < 800 && dist > 1000 && angleTo(car, shifted) < 0.1) targetSpeed = 0;
      this.drive.target_speed = targetSpeed;
      this.drive.backwards = this.backwards;
      this.action = (this.allow_dodges_and_wavedashes && norm(car.velocity) < targetSpeed - 600 && car.boost < 20 && !this.backwards) || !this.travel.driving
        ? this.travel : this.drive;
      this.action.step(dt);
      this.controls = Object.assign(Input(), this.action.controls);
      this.finished = car.time >= this.arrival_time;
    }
  }

  // RLUtilities Aerial equivalent: jump (optionally double jump), then point the nose along the acceleration still
  // needed to reach target_position at arrival_time and boost while roughly aligned
  class Aerial extends Maneuver {
    constructor(car) {
      super(car);
      this.target_position = vec(); this.arrival_time = 0; this.up = [0, 0, 1]; this.angle_threshold = 0.3;
      this.double_jump = false; this.target_orientation = null; this.timer = 0; this.leftGround = !car.on_ground;
    }
    interruptible() { return false; }
    step(dt) {
      const car = this.car, c = Input(), T = Math.max(this.arrival_time - car.time, 0.02);
      if (!this.leftGround) {
        c.jump = true;
        if (this.timer > 0.2 || !car.on_ground) this.leftGround = this.timer > 0.2;
      } else if (this.double_jump && !this.doubled) {
        if (this.timer < 0.24) c.jump = false; else { c.jump = true; this.doubled = true; }
      }
      const delta = sub(sub(this.target_position, car.position), add(mul(car.velocity, T), [0, 0, -325 * T * T]));
      const need = norm(delta), dir = normalize(delta);
      if (need > 60 || !this.target_orientation) Ctl.reorient(car.sim, toVec3(need > 1 ? dir : car.forward), toVec3(this.up), c, 5);
      else Ctl.reorient(car.sim, toVec3(this.target_orientation.forward), toVec3(this.target_orientation.up), c, 5);
      c.boost = this.timer > 0.1 && car.boost > 0 && angleBetween(car.forward, dir) < this.angle_threshold && 2 * need / (T * T) > 200;
      this.controls = c;
      this.timer += dt;
      this.finished = this.arrival_time - car.time < -0.2 || (this.timer > 0.5 && car.on_ground);
    }
  }

  // AerialStrike.simulate_flight stand-in: can a jump plus boost reach `target` at `arrival`? Returns the miss in uu.
  function aerialMiss(car, target, arrival, doubleJump) {
    const T = arrival - car.time;
    if (T < 0.35) return Infinity;
    const jumpVel = car.on_ground ? 292 + 292 + (doubleJump ? 292 : 0) : 0;
    const v0 = add(car.velocity, mul(car.up, jumpVel));
    const delta = sub(sub(target, car.position), add(mul(v0, T), [0, 0, -325 * T * T]));
    const flyTime = Math.max(T - 0.3, 0.05);
    const accel = 2 * norm(delta) / (flyTime * flyTime);
    const boostNeeded = Math.min(accel / 1000, 1) * flyTime * 33.3;
    if (boostNeeded > car.boost) return 1000;
    return accel < 900 ? 0 : (accel - 900) * flyTime * flyTime / 2;
  }

  // maneuvers/recovery.py
  class Recovery extends Maneuver {
    constructor(car, jumpWhenUpsideDown = true) { super(car); this.jump_when_upside_down = jumpWhenUpsideDown; this.landing = false; this.reorient = new Reorient(car); }
    interruptible() { return false; }
    simulateLanding() {
      let p = this.car.position.slice(), v = this.car.velocity.slice(), normal = null;
      this.landing = false;
      for (let i = 0; i < 48; i++) {
        p = add(p, mul(v, 1 / 60));
        v = add(v, [0, 0, -650 / 60]);
        if (norm(v) > 2300) v = mul(normalize(v), 2300);
        normal = fieldCollide(p, 50);
        if ((normal || p[2] < 0) && i > 20) { this.landing = true; break; }
      }
      if (this.landing && normal) {
        const u = normal, f = normalize(sub(v, mul(u, dot(v, u))));
        this.reorient.target_orientation = { forward: f, left: normalize(cross(u, f)), up: u };
      } else {
        this.reorient.target_orientation = lookAt(normalize(sub(normalize(this.car.velocity), [0, 0, 3])), [0, 0, 1]);
      }
    }
    step(dt) {
      this.simulateLanding();
      this.reorient.step(dt);
      const c = this.controls = Object.assign(Input(), this.reorient.controls);
      c.boost = angleBetween(this.car.forward, [0, 0, -1]) < 1.5 && !this.landing;
      c.throttle = 1;
      if (this.jump_when_upside_down && this.car.on_ground && this.car.up[2] < -0.95) { c.jump = true; this.landing = false; }
      else this.finished = this.car.on_ground;
    }
  }

  return {
    math: { clamp, clamp11, absClamp, sign, nonzero, rangeMap, vec, add, sub, mul, dot, cross, norm, normalize, angleBetween, ground, distance, groundDistance, direction, groundDirection, xy, local, world, angleTo, align, nearestPoint, farthestPoint, lookAt, toVec3, Input },
    Arena, fieldCollide, gameInfo, GameInfo, Goal, estimateTime, Intercept, turnRadius,
    Maneuver, Drive, Stop, Reorient, Jump, Dodge, Wavedash, AirDodge, AimDodge, HalfFlip, SpeedFlip, Travel, Arrive, Aerial, aerialMiss, Recovery
  };
})();
