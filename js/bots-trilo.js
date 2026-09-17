// Trilo: a freestyle bot built on Nexto. Nexto's network drives (its speed, challenges and aggression), and
// every few ticks Trilo looks for a freestyle setup; whenever it finds one it takes over and goes for it:
//  - rolling ball near it: catch it onto the roof and dribble, then flick (front, 45 degree or musty flick)
//    or pop it into an air dribble toward goal, bumping anyone in the way (air dribble bump)
//  - ball up a side wall: drive up under it and take it off the wall into an air dribble
//  - ball hanging in the air: fast aerial under it, turn wheels-up to get a flip reset, then flip into it
//  - ball heading for the backboard: aerial into it, read the rebound and double tap it
//  - driving up a wall with the ball high: climb to the ceiling, drop off and flip into it (ceiling shot)
//  - ground movement tech on top of Nexto: wave dashes when landing, half flips, wall dashes and demos
// Mechanics steer with this game's RocketSim physics directly (controls follow RLBot conventions).
window.Game = window.Game || {};

(function () {
  const BT = Game.RL.BT_TO_UU, { Vec3 } = Game.Math, B = Game.Botimus;
  const { add, sub, mul, dot, cross, norm, normalize, clamp } = B.math;
  const BALL_R = 92.75, GRAVITY = 650;
  const V = a => new Vec3(a[0], a[1], a[2]);
  const flat = a => [a[0], a[1], 0];
  const blank = () => ({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });
  const rand = (a, b) => a + Math.random() * (b - a);

  // Everything a mechanic needs about the car, ball and goals this tick (uu)
  function read(world, index) {
    const car = world.cars[index], b = car.body, R = b.rot, st = car.state, ball = world.ball;
    const f = R.col(0), r = R.col(1), u = R.col(2), sign = car.team === 'blue' ? 1 : -1;
    const s = {
      world, car, index, st, sign,
      pos: [b.pos.x * BT, b.pos.y * BT, b.pos.z * BT], vel: [b.linVel.x * BT, b.linVel.y * BT, b.linVel.z * BT],
      f: [f.x, f.y, f.z], r: [r.x, r.y, r.z], u: [u.x, u.y, u.z],
      onGround: st.isOnGround, boost: st.boost,
      hasFlip: !st.hasDoubleJumped && !st.hasFlipped && (!st.hasJumped || st.airTimeSinceJump < 1.2),
      ball: [ball.pos.x * BT, ball.pos.y * BT, ball.pos.z * BT], ballVel: [ball.linVel.x * BT, ball.linVel.y * BT, ball.linVel.z * BT],
      theirGoal: [0, sign * 5120, 320], ownGoal: [0, -sign * 5120, 320]
    };
    s.toBall = sub(s.ball, s.pos);
    s.dist = norm(s.toBall);
    s.flatDist = norm(flat(s.toBall));
    s.speed = norm(s.vel);
    s.fwdSpeed = dot(s.vel, s.f);
    const opps = world.cars.filter(c => c.team !== car.team && !c.isDemoed);
    s.opp = opps.map(c => ({ car: c, pos: [c.body.pos.x * BT, c.body.pos.y * BT, c.body.pos.z * BT], vel: [c.body.linVel.x * BT, c.body.linVel.y * BT, c.body.linVel.z * BT] }))
      .sort((a, c) => norm(sub(a.pos, s.ball)) - norm(sub(c.pos, s.ball)))[0] || null;
    s.oppToBall = s.opp ? norm(sub(s.opp.pos, s.ball)) : Infinity;
    s.oppToMe = s.opp ? norm(sub(s.opp.pos, s.pos)) : Infinity;
    return s;
  }

  // ---------------- control helpers ----------------
  const toLocal = (s, d) => [dot(d, s.f), dot(d, s.r), dot(d, s.u)];

  function driveTo(s, target, c, speed) {
    const l = toLocal(s, sub(target, s.pos)), phi = Math.atan2(l[1], l[0]);
    c.steer = clamp(2.8 * phi, -1, 1);
    c.handbrake = Math.abs(phi) > 1.6 && s.speed > 600;
    const want = speed === undefined ? 2300 : speed;
    c.throttle = s.fwdSpeed < want - 50 ? 1 : s.fwdSpeed > want + 250 ? -1 : 0.05;
    c.boost = c.throttle > 0 && Math.abs(phi) < 0.3 && want - s.fwdSpeed > 300 && s.fwdSpeed < 2250;
    return phi;
  }

  function orient(s, forward, up, c, gain) {
    Game.BotControl.reorient(s.car, V(normalize(forward)), V(normalize(up)), c, gain || 11);
  }

  // Aerial steering: nose along the acceleration still needed to be at `target` in `T` seconds, boosting when lined up
  function flyTo(s, target, T, c, upHint) {
    T = Math.max(T, 0.08);
    const delta = sub(sub(target, s.pos), add(mul(s.vel, T), [0, 0, -0.5 * GRAVITY * T * T]));
    const acc = mul(delta, 2 / (T * T)), need = norm(acc);
    const dir = need > 1 ? normalize(acc) : normalize(sub(target, s.pos));
    orient(s, dir, upHint || [0, 0, 1], c);
    c.boost = s.boost > 0 && dot(s.f, dir) > 0.62 && need > 120;
    c.throttle = 1;
    return need;
  }

  // Flip toward a world direction (front flip = pitch -1, right = yaw +1)
  function dodgeToward(s, dir, c) {
    const l = [dot(dir, s.f), dot(dir, s.r)], k = Math.max(Math.abs(l[0]), Math.abs(l[1]), 1e-6);
    c.jump = true;
    c.pitch = -l[0] / k;
    c.yaw = clamp((s.u[2] < 0 ? -1 : 1) * l[1] / k, -1, 1);
    c.roll = 0;
  }

  // Ball ignoring walls (short look-ahead)
  const ballAt = (s, t) => add(add(s.ball, mul(s.ballVel, t)), [0, 0, -0.5 * GRAVITY * t * t]);

  // Take-off from the ground: first jump held, short release, second jump while pitching back (fast aerial)
  function takeoff(m, s, c, dt) {
    // Jumps only register off the ground, so wait for wheel contact before the first press
    if (!m.lifting) { c.throttle = 1; if (!s.onGround) return (m.wait = (m.wait || 0) + dt) > 0.6; m.lifting = true; }
    m.lift = (m.lift || 0) + dt;
    if (m.lift < 0.18) { c.jump = true; c.pitch = 0.6; }
    else if (m.lift < 0.22) { c.jump = false; c.pitch = 0.6; }
    else if (m.lift < 0.24) { c.jump = true; c.pitch = 0; c.yaw = 0; c.roll = 0; }
    else return true;
    c.boost = true;
    return false;
  }

  // ---------------- mechanics ----------------
  // Each has step(s, c, dt) returning true when finished (Nexto takes back over)

  class Catch {
    constructor() { this.name = 'catch'; this.t = 0; }
    step(s, c, dt) {
      this.t += dt;
      const bv = flat(s.ballVel), bs = norm(bv);
      const along = bs > 150 ? normalize(bv) : normalize(flat(sub(s.theirGoal, s.ball)));
      const aim = sub(add(flat(s.ball), mul(bv, 0.12)), mul(along, 70));
      const d = norm(flat(sub(aim, s.pos)));
      const speed = d < 260 ? dot(bv, s.f) + 260 : Math.min(2300, bs + 250 + d * 1.1);
      driveTo(s, aim, c, speed);
      c.boost = c.boost && d > 900;
      if (s.ball[2] - s.pos[2] > 90 && s.flatDist < 170) { this.next = new Dribble(); return true; }
      return this.t > 3.5 || s.oppToBall < 700 || (this.t > 1 && s.flatDist > 2200) || !s.onGround;
    }
  }

  class Dribble {
    constructor() { this.name = 'dribble'; this.t = 0; this.style = Math.random(); }
    step(s, c, dt) {
      this.t += dt;
      const rel = sub(s.ball, s.pos), relF = dot(rel, s.f), relR = dot(rel, s.r), h = rel[2];
      if (h < 60 || h > 420 || Math.abs(relR) > 150 || relF < -120 || relF > 200 || !s.onGround) return true;
      const toGoal = normalize(flat(sub(s.theirGoal, s.pos))), phi = Math.atan2(dot(toGoal, s.r), dot(toGoal, s.f));
      const centered = Math.abs(relR) < 45 && Math.abs(relF - 20) < 60;
      c.steer = clamp(relR * 0.035 + (centered ? clamp(phi * 1.3, -0.5, 0.5) : 0), -1, 1);
      const want = dot(s.ballVel, s.f) + (relF - 20) * 4.5 + (centered ? 250 : 0);
      c.throttle = s.fwdSpeed < want - 40 ? 1 : s.fwdSpeed > want + 40 ? -0.6 : 0.1;
      c.boost = s.fwdSpeed < want - 450 && s.fwdSpeed < 2100;
      const goalDist = norm(flat(sub(s.theirGoal, s.pos)));
      const pressured = s.oppToMe < 1100 || (s.opp && norm(sub(add(s.opp.pos, mul(s.opp.vel, 0.4)), s.pos)) < 800);
      // Flick when pressured or lined up near goal; pop into an air dribble with boost and space
      if (pressured || (goalDist < 3200 && Math.abs(phi) < 0.35) || this.t > 4) {
        this.next = new Flick(this.style < 0.4 ? 'musty' : this.style < 0.7 ? 'front' : '45', phi);
        return true;
      }
      if (this.t > 1.2 && centered && s.boost > 55 && s.oppToMe > 2500 && goalDist > 3800 && Math.abs(phi) < 0.5) {
        this.next = new AirDribble(true);
        return true;
      }
      return false;
    }
  }

  class Flick {
    constructor(kind, phi) { this.name = kind + ' flick'; this.kind = kind; this.t = 0; this.side = phi > 0 ? 1 : -1; this.flipped = false; }
    step(s, c, dt) {
      this.t += dt;
      c.throttle = 1;
      if (this.kind === 'musty') {
        if (this.t < 0.1) { c.jump = true; c.pitch = 1; }
        else if (this.t < 0.19) { c.jump = false; c.pitch = 1; }
        else if (!this.flipped) { c.jump = true; c.pitch = 1; c.yaw = 0; this.flipped = true; }
        else { c.jump = false; c.pitch = 0; }
      } else {
        if (this.t < 0.08) { c.jump = true; c.pitch = 0; }
        else if (this.t < 0.14) { c.jump = false; }
        else if (!this.flipped) {
          c.jump = true; this.flipped = true;
          if (this.kind === '45') { c.pitch = -0.7; c.yaw = 0.7 * this.side; } else { c.pitch = -1; c.yaw = 0; }
        } else { c.jump = false; c.pitch = 0; c.yaw = 0; }
      }
      return this.t > 0.75;
    }
  }

  class AirDribble {
    constructor(pop) { this.name = pop ? 'air dribble' : 'wall air dribble'; this.t = 0; this.phase = pop ? 'pop' : 'fly'; this.bumpT = 0; }
    step(s, c, dt) {
      this.t += dt;
      if (this.phase === 'pop') {
        if (this.t < 0.2) { c.jump = true; c.pitch = 0.35; c.throttle = 1; c.boost = this.t > 0.08; return false; }
        this.phase = 'fly';
      }
      c.jump = false;
      const toGoal = normalize(sub(s.theirGoal, s.ball));
      const push = normalize(add(toGoal, [0, 0, 0.55]));
      let contact = sub(s.ball, mul(push, BALL_R + 55));
      // Air dribble bump: veer into a defender that's in the way
      if (this.bumpT > 0 || (s.opp && s.oppToMe < 650 && dot(normalize(sub(s.opp.pos, s.pos)), toGoal) > 0.4)) {
        this.bumpT = this.bumpT > 0 ? this.bumpT - dt : 0.35;
        if (s.opp) contact = add(s.opp.pos, mul(s.opp.vel, 0.15));
      }
      const acc = add(add(mul(sub(contact, s.pos), 7), mul(sub(s.ballVel, s.vel), 3.2)), [0, 0, GRAVITY]);
      const dir = normalize(acc);
      orient(s, dir, [0, 0, 1], c);
      c.boost = s.boost > 0 && dot(s.f, dir) > 0.75 && norm(acc) > 250;
      c.throttle = 1;
      const goalDist = norm(sub(s.theirGoal, s.ball));
      // Finish with a flip into the ball near goal
      if (goalDist < 1700 && s.hasFlip && s.dist < 260) { dodgeToward(s, normalize(sub(s.ball, s.pos)), c); this.done = true; }
      return this.done || (this.t > 0.6 && (s.onGround || s.dist > 520)) || s.ball[2] < 180 || this.t > 7;
    }
  }

  class WallAirDribble {
    constructor() { this.name = 'wall air dribble'; this.t = 0; this.phase = 'drive'; }
    step(s, c, dt) {
      this.t += dt;
      if (this.phase === 'drive') {
        const onWall = s.onGround && s.u[2] < 0.6 && s.pos[2] > 150;
        const target = onWall ? add(s.ball, [0, 0, -BALL_R - 40]) : [Math.sign(s.ball[0]) * 4096, s.ball[1] - s.sign * 150, 0];
        driveTo(s, target, c, 2000);
        if (onWall && s.flatDist < 450 && s.ball[2] > s.pos[2]) { this.phase = 'jump'; this.jt = 0; }
        return this.t > 4.5 || (!s.onGround && this.t > 1) || s.ball[2] < 120;
      }
      if (this.phase === 'jump') {
        this.jt += dt;
        c.jump = this.jt < 0.16;
        c.throttle = 1;
        c.boost = this.jt > 0.06;
        if (this.jt >= 0.18) this.phase = 'fly';
        return false;
      }
      if (!this.dribble) this.dribble = new AirDribble(false);
      return this.dribble.step(s, c, dt);
    }
  }

  class FlipReset {
    constructor() { this.name = 'flip reset'; this.t = 0; this.phase = 'takeoff'; }
    step(s, c, dt, events) {
      this.t += dt;
      const reset = events.some(e => e.type === 'flipReset' && e.car === s.index);
      if (reset && this.phase !== 'shoot') { this.phase = 'shoot'; this.resetAt = this.t; }
      if (this.phase === 'takeoff') { if (takeoff(this, s, c, dt)) this.phase = 'approach'; return false; }
      c.jump = false;
      if (this.phase === 'approach') {
        // Fly at the underside of the ball with the nose up; the wheels-up turn starts early because it takes time
        // Aim at the ball itself so the car arrives with upward speed (a slow touch doesn't reset the flip)
        const T = clamp(s.dist / 1600, 0.2, 1.4), into = add(ballAt(s, T), [0, 0, -20]);
        flyTo(s, into, T, c);
        if (s.dist < 950 && s.pos[2] < s.ball[2] - 60 && s.vel[2] - s.ballVel[2] > 350) this.phase = 'touch';
      } else if (this.phase === 'touch') {
        // Wheels toward the ball: roof points away from it, nose toward goal
        // Smallest turn: keep the nose where it is and only swing the underside toward the ball
        const away = normalize(sub(s.pos, s.ball));
        let fwd = sub(s.f, mul(away, dot(s.f, away)));
        if (norm(fwd) < 0.2) { const goal = normalize(sub(s.theirGoal, s.ball)); fwd = sub(goal, mul(away, dot(goal, away))); }
        fwd = normalize(fwd);
        orient(s, fwd, away, c);
        c.boost = false;
        c.throttle = 0;
        if (this.t > 4) return true;
      } else if (this.phase === 'shoot') {
        const behind = sub(s.ball, mul(normalize(sub(s.theirGoal, s.ball)), BALL_R + 70));
        flyTo(s, behind, clamp(s.dist / 1500, 0.15, 0.8), c);
        if (s.dist < 250 && s.hasFlip) { dodgeToward(s, normalize(sub(s.ball, s.pos)), c); this.flipAt = this.t; this.phase = 'done'; }
        if (this.t - this.resetAt > 2.2) return true;
      } else {
        c.jump = false;
        return this.t - this.flipAt > 0.6;
      }
      // Wheels on the ball also count as 'on the ground', so only the floor ends it
      return this.t > 5.5 || (this.t > 0.6 && s.onGround && s.pos[2] < 80) || s.ball[2] < 150;
    }
  }

  class DoubleTap {
    constructor() { this.name = 'double tap'; this.t = 0; this.phase = 'takeoff'; this.touch = null; }
    step(s, c, dt) {
      this.t += dt;
      if (this.touch === null) this.touch = s.car.lastBallTouchTick;
      if (this.phase === 'takeoff') { if (takeoff(this, s, c, dt)) this.phase = 'first'; return false; }
      c.jump = false;
      if (this.phase === 'first') {
        const T = clamp(s.dist / 1600, 0.15, 1.5), p = ballAt(s, T), toBoard = normalize(sub([s.ball[0] * 0.3, s.sign * 5120, 1300], p));
        flyTo(s, sub(p, mul(toBoard, BALL_R + 60)), T, c);
        if (s.car.lastBallTouchTick !== this.touch) { this.phase = 'read'; this.hitAt = this.t; }
        return this.t > 3 || (this.t > 0.6 && s.onGround);
      }
      // Rebound off the backboard: aim at the ball once it's coming back out
      const info = B.gameInfo(s.world, s.sign > 0 ? 0 : 1);
      info.predict_ball(2.5);
      const back = info.ball_predictions.find(b => b.velocity[1] * s.sign < 0 && Math.abs(b.position[1]) > 4200 && b.position[2] > 250);
      if (back) {
        const T = back.time - info.time, behind = sub(back.position, mul(normalize(sub(s.theirGoal, back.position)), BALL_R + 70));
        flyTo(s, behind, T, c);
        if (s.dist < 260 && s.hasFlip && Math.abs(s.ball[1]) < 5000) { dodgeToward(s, normalize(sub(s.theirGoal, s.pos)), c); this.done = true; }
      } else {
        orient(s, normalize(sub(s.ball, s.pos)), [0, 0, 1], c);
      }
      return this.done || this.t - this.hitAt > 2.5 || s.onGround;
    }
  }

  class CeilingShot {
    constructor() { this.name = 'ceiling shot'; this.t = 0; this.phase = 'climb'; }
    step(s, c, dt) {
      this.t += dt;
      if (this.phase === 'climb') {
        // Drive straight up the wall (world up seen in the car's plane), then along the ceiling
        const onCeiling = s.onGround && s.u[2] < -0.7;
        const target = onCeiling ? [s.ball[0], s.ball[1], 2044] : add(s.pos, [0, 0, 800]);
        driveTo(s, target, c, 2000);
        if (onCeiling) { this.ceilingT = (this.ceilingT || 0) + dt; if (this.ceilingT > 0.35) { this.phase = 'drop'; this.dropT = 0; } }
        return this.t > 4.5 || (!s.onGround && this.t > 0.5 && this.phase === 'climb');
      }
      if (this.phase === 'drop') {
        this.dropT += dt;
        c.jump = this.dropT < 0.05;
        c.throttle = 0;
        if (this.dropT > 0.12) this.phase = 'fall';
        return false;
      }
      c.jump = false;
      const T = clamp(s.dist / 1500, 0.15, 1.2), behind = sub(ballAt(s, T), mul(normalize(sub(s.theirGoal, s.ball)), BALL_R + 70));
      flyTo(s, behind, T, c);
      if (s.dist < 260 && s.hasFlip) { dodgeToward(s, normalize(sub(s.ball, s.pos)), c); this.done = true; }
      return this.done || s.onGround || this.t > 6;
    }
  }

  class HalfFlip {
    constructor(s) { this.name = 'half flip'; this.t = 0; this.dir = Math.sign(dot(s.vel, s.r)) || 1; }
    step(s, c, dt) {
      this.t += dt;
      c.throttle = -1;
      if (this.t < 0.1) c.jump = true;
      else if (this.t < 0.14) c.jump = false;
      else if (this.t < 0.16) { c.jump = true; c.pitch = 1; }
      else if (this.t < 0.45) { c.jump = false; c.pitch = -1; }
      else { c.pitch = -1; c.roll = this.dir; c.yaw = this.dir; c.throttle = 1; c.boost = this.t > 0.6; }
      return (this.t > 0.6 && s.onGround) || this.t > 1.6;
    }
  }

  class WallDash {
    constructor() { this.name = 'wall dash'; this.t = 0; }
    step(s, c, dt) {
      this.t += dt;
      c.throttle = 1;
      if (this.t < 0.03) c.jump = true;
      else if (this.t < 0.06) c.jump = false;
      else if (this.t < 0.08) { c.jump = true; c.pitch = -1; }
      else c.jump = false;
      return this.t > 0.3;
    }
  }

  class Demo {
    constructor() { this.name = 'demo'; this.t = 0; }
    step(s, c, dt) {
      this.t += dt;
      if (!s.opp || s.opp.car.demoImmune) return true;
      driveTo(s, add(s.opp.pos, mul(s.opp.vel, Math.min(s.oppToMe / 2300, 0.4))), c, 2300);
      c.boost = s.boost > 0 && s.onGround;
      return this.t > 2.2 || s.opp.car.isDemoed || !s.onGround;
    }
  }

  // ---------------- the bot ----------------
  class TriloBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Trilo';
      this.nexto = new Game.BotsNecto.NextoBot(world, carIndex);
      this.reset();
    }

    get ready() { return this.nexto.ready; }

    reset() {
      this.nexto.reset();
      this.mech = null;
      this.cooldown = 1.2;
      this.scan = 0;
      this.airTime = 0;
      this.wallDashT = 0;
      this.lastJump = false;
      this.log = this.log || [];
    }

    start(m) {
      this.mech = m;
      this.log.push(m.name);
      if (this.log.length > 40) this.log.shift();
    }

    // Looks for a freestyle setup; returns a mechanic or null
    findSetup(s) {
      const ballH = s.ball[2], ballSpeed = norm(s.ballVel), towardOwn = dot(s.ballVel, [0, -s.sign, 0]);
      if (s.onGround && s.u[2] > 0.9) {
        const rel = sub(s.ball, s.pos);
        if (rel[2] > 90 && rel[2] < 260 && norm(flat(rel)) < 150 && norm(sub(s.ballVel, s.vel)) < 500) return new Dribble();
        if (s.boost > 45 && s.flatDist < 2600 && ballH > 450 && ballH < 1500 && ballSpeed < 1300 && s.oppToBall > 1800) {
          const info = B.gameInfo(this.world, s.sign > 0 ? 0 : 1);
          info.predict_ball(1.4);
          if (info.ball_predictions.every(b => b.position[2] > 380)) return new FlipReset();
        }
        if (s.boost > 45 && ballH > 700 && s.ballVel[1] * s.sign > 800 && s.ball[1] * s.sign > 2000 && s.dist < 3200 && s.dist > 700) return new DoubleTap();
        if (s.boost > 50 && Math.abs(s.ball[0]) > 3450 && ballH > 250 && ballH < 1100 && s.ballVel[2] > -150 && s.flatDist < 2200 && s.oppToBall > 1500) return new WallAirDribble();
        if (ballH < 140 && ballSpeed > 100 && ballSpeed < 1300 && s.flatDist < 1700 && Math.abs(s.ball[0]) < 3300 && Math.abs(s.ball[1]) < 4300 &&
            towardOwn < 700 && s.oppToBall > 1600) return new Catch();
        if (s.opp && !s.opp.car.demoImmune && s.boost > 40 && s.oppToMe < 1800 && s.flatDist > 1500 && s.oppToBall > 1200) {
          const d = normalize(flat(sub(s.opp.pos, s.pos)));
          if (dot(d, s.f) > 0.9 && s.opp.pos[2] < 120) return new Demo();
        }
      }
      if (s.onGround && s.u[2] < 0.3 && s.pos[2] > 400 && s.boost > 40 && ballH > 900 && s.flatDist < 3500) return new CeilingShot();
      return null;
    }

    // Movement tech layered on Nexto's own driving
    movementTech(s, base) {
      const c = Object.assign({}, base);
      if (s.onGround && s.u[2] > 0.9 && s.fwdSpeed < -600 && dot(normalize(flat(s.toBall)), s.f) < -0.6 && s.flatDist > 700) {
        this.start(new HalfFlip(s));
        return null;
      }
      // Wave dash: dodge just before the wheels touch down when falling toward the ball
      if (!s.onGround && this.airTime > 0.35 && s.vel[2] < -250 && s.pos[2] > 22 && s.pos[2] < 60 && s.u[2] > 0.9 && s.hasFlip && !this.lastJump) {
        const dir = normalize(flat(s.toBall));
        if (dot(dir, s.f) > 0.3) { dodgeToward(s, dir, c); c.handbrake = true; this.log.push('wave dash'); return c; }
      }
      if (s.onGround && s.u[2] < 0.4 && s.pos[2] > 300 && base.throttle > 0 && s.speed < 1600 && this.wallDashT <= 0) {
        this.wallDashT = 0.5;
        this.start(new WallDash());
        return null;
      }
      return c;
    }

    tick() {
      const base = this.nexto.tick(), w = this.world, dt = 1 / 120;
      if (!this.ready) return base;
      const s = read(w, this.index);
      this.airTime = s.onGround ? 0 : this.airTime + dt;
      this.wallDashT -= dt;
      if (w.kickoffPause || s.car.isDemoed) { this.mech = null; return this.finish(base); }
      this.cooldown -= dt;
      let out = null;
      try {
        if (!this.mech && this.cooldown <= 0 && --this.scan <= 0) {
          this.scan = 6;
          const m = this.findSetup(s);
          if (m) this.start(m);
        }
        if (!this.mech) {
          out = this.movementTech(s, base);
        }
        if (this.mech) {
          const c = blank();
          const done = this.mech.step(s, c, dt, w.events);
          out = c;
          if (done) {
            const next = this.mech.next;
            this.mech = null;
            if (next) this.start(next); else this.cooldown = 0.5;
          }
        }
      } catch (e) {
        if (!this.warned) { this.warned = true; console.warn('Trilo mechanic error', e); }
        this.mech = null;
        out = base;
      }
      return this.finish(out || base);
    }

    finish(c) {
      this.lastJump = !!c.jump;
      return c;
    }
  }

  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'nexto') + 1, 0,
    { id: 'trilo', name: 'Trilo', desc: "A freestyler with Nexto's speed and aggression. Whenever it spots a setup it goes for it: catches into dribbles, musty and 45 flicks, air dribbles off the ground and the wall, flip resets, double taps, ceiling shots, wave dashes, half flips and wall dashes. Also plays in free play, so you can watch it show off.",
      modes: ['freeplay', '1v1', '2v2', '3v3'], make: (w, i) => new TriloBot(w, i), load: () => Game.BotsNecto.loadModel('nexto') });

  Game.BotsTrilo = { TriloBot, read, flyTo, takeoff, orient, dodgeToward };
})();
