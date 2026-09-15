// Botimus Prime & Bumblebee, part 2: strikes, dribbles, kickoffs, defense and the solo, teamplay and hivemind
// strategies, ported from Darxeal's BotimusPrime (RLBotPack, MIT). Mechanics come from bots-botimus-core.js.
// Botimus plays on its own; Bumblebee is the hivemind version where one "hive" per team coordinates every
// Bumblebee: who takes the kickoff, who grabs boost, who goes for the ball and who stays back.
window.Game = window.Game || {};

(function () {
  const B = Game.Botimus, M = B.math;
  const { add, sub, mul, dot, cross, norm, normalize, ground, distance, groundDistance, direction, groundDirection, xy, local, world,
    angleTo, align, lookAt, clamp, absClamp, rangeMap, nearestPoint, farthestPoint, sign, Input } = M;
  const minBy = (arr, f) => arr.reduce((a, b) => (f(b) < f(a) ? b : a));

  // ---------------- strikes (maneuvers/strikes) ----------------
  function pickEasiestTarget(info, car, ball, targets) {
    const toGoal = groundDirection(ball, info.their_goal.center);
    const score = t => dot(add(groundDirection(car, ball), mul(toGoal, 0.5)), groundDirection(ball, t));
    return targets.reduce((a, b) => (score(b) > score(a) ? b : a)).slice();
  }

  // Construct with `new`, then call start() once the subclass has set its fields (Python sets them before super)
  class Strike extends B.Maneuver {
    constructor(car, info, target) {
      super(car);
      this.info = info;
      this.target = target ? target.slice() : null;
      this.arrive = new B.Arrive(car);
      this.intercept = null;
      this.allow_backwards = false;
      this.update_interval = 0.2;
      this.stop_updating = 0.1;
      this.max_additional_time = 0.4;
      this._last_update_time = car.time;
      this._should_strike_backwards = false;
      this._initial_time = Infinity;
    }
    start() { this.update_intercept(); this._initial_time = this.intercept.time; return this; }
    intercept_predicate() { return true; }
    configure(i) {
      this.arrive.target = i.ground_pos;
      this.arrive.arrival_time = i.time;
      this.arrive.backwards = this._should_strike_backwards;
      this.arrive.asap = !i.predicate_later_than_time;
    }
    update_intercept() {
      const pred = (c, b) => this.intercept_predicate(c, b);
      this.intercept = new B.Intercept(this.car, this.info.ball_predictions, pred);
      if (this.allow_backwards) {
        const back = new B.Intercept(this.car, this.info.ball_predictions, pred, false, true);
        this._should_strike_backwards = back.time + 0.1 < this.intercept.time;
        if (this._should_strike_backwards) this.intercept = back;
      }
      this.configure(this.intercept);
      this._last_update_time = this.car.time;
      if (!this.intercept.is_viable || this.intercept.time > this._initial_time + this.max_additional_time) this.finished = true;
    }
    interruptible() { return this.arrive.interruptible(); }
    step(dt) {
      const car = this.car;
      if (this._last_update_time + this.update_interval < car.time && car.time < this.intercept.time - this.stop_updating && car.on_ground && !this.controls.jump) {
        this.info.predict_ball(this.intercept.time - car.time + 1);
        this.update_intercept();
      }
      if (this.intercept.time - car.time > 1 && this.interruptible() && !car.on_ground) this.finished = true;
      this.arrive.step(dt);
      this.controls = Object.assign(Input(), this.arrive.controls);
      if (this.arrive.drive.target_speed < 300) this.controls.throttle = 0;
      if (this.arrive.finished) this.finished = true;
    }
  }

  // dodge_strike.py: arrive at the ball and dodge into it
  class DodgeStrike extends Strike {
    constructor(car, info, target) {
      super(car, info, target);
      this.additional_jump_time = 0;
      this.dodge = new B.AimDodge(car, 0.1, info.ball.position);
      this.dodging = false;
    }
    intercept_predicate(car, ball) {
      if (ball.time - car.time < this.get_jump_duration(ball.position[2])) return false;
      return ball.position[2] < 300;
    }
    get_jump_duration(h) { return 0.05 + clamp((h - 92) / 500, 0, 1.5) + this.additional_jump_time; }
    configure(i) {
      super.configure(i);
      const ball = i.ball, td = groundDirection(ball, this.target);
      let hitDir = groundDirection(ball.velocity, mul(td, norm(ball.velocity) * 3 + 500)), offset = 165;
      const toBall = groundDirection(this.car, ball);
      if (dot(hitDir, toBall) < 0) {
        const perp = cross(toBall, [0, 0, 1]);
        hitDir = dot(perp, hitDir) > 0 ? perp : mul(perp, -1);
        offset = 130;
      }
      this.arrive.target = sub(i.ground_pos, mul(hitDir, offset));
      this.arrive.target_direction = hitDir;
      this.dodge.jump.duration = this.get_jump_duration(ball.position[2]);
      this.dodge.target = i.ball.position;
      this.arrive.additional_shift = this.get_jump_duration(ball.position[2]) * 1000;
    }
    interruptible() {
      if (this.info.ball.position[2] > 150 && this.dodging) return true;
      return !this.dodging && super.interruptible();
    }
    step(dt) {
      if (this.dodging) {
        this.dodge.step(dt);
        this.controls = Object.assign(Input(), this.dodge.controls);
      } else {
        super.step(dt);
        const car = this.car;
        if (this.arrive.arrival_time - car.time < this.dodge.jump.duration + 0.13 &&
            Math.abs(this.arrive.drive.target_speed - norm(car.velocity)) < 1000 &&
            (dot(normalize(car.velocity), groundDirection(car, this.arrive.target)) > 0.95 || norm(car.velocity) < 500)) this.dodging = true;
      }
      if (this.dodge.finished) this.finished = true;
    }
  }

  // close_shot.py: near the goal, aim at the part of the goal nearest the ball
  class CloseShot extends DodgeStrike {
    constructor(car, info, target) { super(car, info, target); this.additional_jump_time = 0.1; }
    intercept_predicate(car, ball) { return super.intercept_predicate(car, ball) && ball.position[2] < 250; }
    configure(i) { this.target[0] = absClamp(this.intercept.ground_pos[0], 300); super.configure(i); }
  }

  // ground_strike.py: just drive through the ball (chips a rolling ball)
  class GroundStrike extends Strike {
    constructor(car, info, target) { super(car, info, target); this.max_additional_time = 0.3; }
    intercept_predicate(car, ball) {
      if (ball.position[2] > 200 || Math.abs(ball.position[1]) > 5020) return false;
      const n = B.fieldCollide(ball.position, 120);
      return !!n && Math.abs(dot(ball.velocity, n)) < 300;
    }
    configure(i) {
      const td = groundDirection(i, this.target), sd = groundDirection(i.ball.velocity, mul(td, 4000));
      this.arrive.target = sub(i.position, mul(sd, 105));
      this.arrive.target_direction = sd;
      this.arrive.arrival_time = i.time;
    }
  }

  // mirror_strike.py: bank the ball off a side wall toward the target
  class MirrorStrike extends DodgeStrike {
    constructor(car, info, target) {
      const mirrored = s => [2 * 4096 * s - target[0], target[1], target[2]];
      super(car, info, pickEasiestTarget(info, car, info.ball, [mirrored(1), mirrored(-1)]));
    }
  }

  // aerial_strike.py
  class AerialStrike extends Strike {
    constructor(car, info, target) {
      super(car, info, target);
      Object.assign(this, { MAX_DISTANCE_ERROR: 50, DELAY_TAKEOFF: true, MINIMAL_HEIGHT: 500, MAXIMAL_HEIGHT: 800, MINIMAL_HEIGHT_TIME: 0.8, MAXIMAL_HEIGHT_TIME: 1.5, DOUBLE_JUMP: false });
      this.aerial = new B.Aerial(car);
      this.aerial.angle_threshold = 0.8;
      this.arrive.allow_dodges_and_wavedashes = false;
      this.aerialing = false;
      this.too_early = false;
    }
    start() { this.aerial.double_jump = this.DOUBLE_JUMP; return super.start(); }
    intercept_predicate(car, ball) {
      const z = ball.position[2];
      const required = rangeMap(z, this.MINIMAL_HEIGHT, this.MAXIMAL_HEIGHT, this.MINIMAL_HEIGHT_TIME, this.MAXIMAL_HEIGHT_TIME);
      return this.MINIMAL_HEIGHT < z && z < this.MAXIMAL_HEIGHT && ball.time - car.time > required;
    }
    configure(i) {
      super.configure(i);
      this.aerial.target_position = sub(i.position, mul(direction(i, this.target), 100));
      this.aerial.up = normalize(add(groundDirection(i, this.car), [0, 0, 0.5]));
      this.aerial.arrival_time = i.time;
    }
    interruptible() { return this.aerialing || super.interruptible(); }
    takeOff() {
      const old = this.aerial, a = new B.Aerial(this.car);
      Object.assign(a, { target_position: old.target_position, arrival_time: old.arrival_time, up: old.up, angle_threshold: old.angle_threshold, double_jump: old.double_jump });
      this.aerial = a;
      this.aerialing = true;
    }
    step(dt) {
      const car = this.car, a = this.aerial, timeLeft = a.arrival_time - car.time;
      if (this.aerialing) {
        const toBall = direction(car, this.info.ball);
        if (car.position[2] > 200) a.up = add([0, 0, -1], xy(toBall));
        if (timeLeft > 0.5) {
          this.info.predict_ball(3);
          const same = new B.Intercept(car, this.info.ball_predictions, (c, b) => b.time >= this.intercept.time, true);
          this.configure(same);
        }
        a.target_orientation = lookAt(toBall, add([0, 0, -3], toBall));
        a.step(dt);
        this.controls = Object.assign(Input(), a.controls);
        this.finished = a.finished && timeLeft < -0.3;
        return;
      }
      super.step(dt);
      const miss = B.aerialMiss(car, a.target_position, a.arrival_time, a.double_jump);
      const speedTowards = dot(car.velocity, groundDirection(car, a.target_position));
      const speedNeeded = groundDistance(car, a.target_position) / Math.max(timeLeft, 0.01);
      if (speedTowards > speedNeeded && angleTo(car, a.target_position) < 0.1) {
        this.controls.throttle = -1;
      } else if (miss < this.MAX_DISTANCE_ERROR) {
        if (angleTo(car, a.target_position) < 0.1 || norm(car.velocity) < 1000) {
          if (this.DELAY_TAKEOFF && groundDistance(car, a.target_position) > 1000) {
            const future = Object.assign({}, car, { time: car.time + 0.5 });
            future.position = add(car.position, norm(car.velocity) > 500 ? mul(car.velocity, 0.5) : mul(normalize(car.velocity), 250));
            if (B.aerialMiss(future, a.target_position, a.arrival_time, a.double_jump) > this.MAX_DISTANCE_ERROR) this.takeOff();
            else this.too_early = true;
          } else {
            this.takeOff();
          }
        }
      } else {
        this.controls.throttle = 1;
      }
    }
  }

  class FastAerialStrike extends AerialStrike {
    constructor(car, info, target) {
      super(car, info, target);
      Object.assign(this, { DELAY_TAKEOFF: false, MINIMAL_HEIGHT: 800, MAXIMAL_HEIGHT: 1800, MINIMAL_HEIGHT_TIME: 1.3, MAXIMAL_HEIGHT_TIME: 2.5, DOUBLE_JUMP: true });
    }
  }

  // clears.py: hit the ball toward the side walls
  const ONE_SIDE = Array.from({ length: 60 }, (_, k) => [4096, 5120 * (k - 30) / 30, 0]);
  const OTHER_SIDE = ONE_SIDE.map(p => [-p[0], p[1], 0]);
  const clearTargets = (car, ball) => (Math.abs(ball.position[0] - car.position[0]) < 1000 ? (ball.position[0] > 0 ? ONE_SIDE : OTHER_SIDE) : ONE_SIDE.concat(OTHER_SIDE));
  class DodgeClear extends DodgeStrike {
    configure(i) { this.target = pickEasiestTarget(this.info, this.car, i.ball, clearTargets(this.car, i.ball)); super.configure(i); }
  }
  class FastAerialClear extends FastAerialStrike {
    configure(i) { this.target = pickEasiestTarget(this.info, this.car, i.ball, clearTargets(this.car, i.ball)); super.configure(i); }
  }

  // double_touch.py: after an aerial hit, keep flying for a second touch if one is reachable
  class DoubleTouch extends B.Maneuver {
    constructor(strike) {
      super(strike.car);
      this.aerial_strike = strike;
      this.info = strike.info;
      this.aerial = new B.Aerial(this.car);
      this.aerial.up = [0, 0, -1];
      this.intercept = strike.intercept;
    }
    find_second_touch() {
      this.info.predict_ball(4);
      const preds = this.info.ball_predictions;
      for (let i = 0; i < preds.length; i += 3) {
        const ball = preds[i];
        if (ball.position[2] < 500) break;
        const target = sub(ball.position, mul(direction(ball, this.aerial_strike.target), 80));
        if (B.aerialMiss(this.car, target, ball.time, false) < 50) {
          this.aerial.target_position = target;
          this.aerial.arrival_time = ball.time;
          this.aerial.leftGround = true;
          return;
        }
      }
      this.finished = true;
    }
    step(dt) {
      if (this.aerial_strike.finished) {
        this.aerial.step(dt);
        this.controls = Object.assign(Input(), this.aerial.controls);
        this.finished = this.aerial.finished || this.car.on_ground;
      } else {
        this.aerial_strike.step(dt);
        this.controls = Object.assign(Input(), this.aerial_strike.controls);
        if (this.aerial_strike.finished) { if (!this.car.on_ground) this.find_second_touch(); else this.finished = true; }
      }
    }
    interruptible() { return this.aerial_strike.interruptible(); }
  }

  // ---------------- dribbling (maneuvers/dribbling) ----------------
  class Carry extends B.Maneuver {
    constructor(car, info, target) { super(car); this.info = info; this.target = ground(target); this.drive = new B.Drive(car); }
    step(dt) {
      const car = this.car;
      this.info.predict_ball(6);
      const preds = this.info.fullPrediction;
      const ball = preds.find(b => b.position[2] <= 120 && b.velocity[2] <= 0) || preds[preds.length - 1] || this.info.ball;
      const ballLocal = local(car, ground(ball.position)), target = local(car, this.target);
      let shift = ground(direction(ballLocal, target));
      shift[1] *= 1.8;
      shift = normalize(shift);
      const maxTurn = clamp(norm(car.velocity) / 800, 0, 1);
      const maxShift = normalize([1 - maxTurn, maxTurn * sign(shift[1]), 0]);
      if (Math.abs(shift[1]) > Math.abs(maxShift[1]) || shift[0] < 0) shift = maxShift;
      shift = mul(shift, clamp(car.boost, 40, 60));
      shift[1] *= clamp(norm(car.velocity) / 1000, 1, 2);
      const t = world(car, sub(ballLocal, shift));
      this.drive.target_speed = distance(car.position, t) / Math.max(0.001, ball.time - car.time);
      this.drive.target_pos = t;
      this.drive.step(dt);
      this.controls = Object.assign(Input(), this.drive.controls);
      this.finished = this.info.ball.position[2] < 100 || groundDistance(this.info.ball, car) > 2000;
    }
  }

  class CarryAndFlick extends B.Maneuver {
    constructor(car, info, target) {
      super(car);
      this.info = info; this.target = target;
      this.carry = new Carry(car, info, target);
      this.flick = new B.AirDodge(car, 0.1, info.ball.position);
      this.flicking = false;
    }
    interruptible() { return !this.flicking; }
    step(dt) {
      const car = this.car, ball = this.info.ball;
      if (!this.flicking) {
        this.carry.step(dt);
        this.controls = Object.assign(Input(), this.carry.controls);
        this.finished = this.carry.finished;
        const dirToTarget = groundDirection(car, this.target);
        if (distance(car, ball) < 150 && groundDistance(car, ball) < 100 && dot(car.forward, dirToTarget) > 0.7 &&
            norm(car.velocity) > clamp(distance(car, this.target) / 3, 1000, 1700) && dot(dirToTarget, groundDirection(car, ball)) > 0.9) this.flicking = true;
        for (const opp of this.info.get_opponents()) {
          if (distance(add(opp.position, opp.velocity), car) < Math.max(300, norm(opp.velocity) * 0.5) && dot(opp.velocity, direction(opp, ball)) > 0.5) {
            if (distance(car.position, ball.position) < 200) this.flicking = true; else this.finished = true;
          }
        }
      } else {
        this.flick.target = add(ball.position, mul(ball.velocity, 0.2));
        this.flick.step(dt);
        this.controls = Object.assign(Input(), this.flick.controls);
        this.finished = this.flick.finished;
      }
    }
  }

  // ---------------- kickoffs (maneuvers/kickoffs) ----------------
  class Kickoff extends B.Maneuver {
    constructor(car, info) { super(car); this.info = info; this.drive = new B.Drive(car, [0, 0, 0], 2300); this.action = this.drive; this.phase = 1; }
    interruptible() { return false; }
    counter_fake_kickoff() {
      if (this.info.get_opponents().some(o => distance(this.info.ball, o) < 1500)) return;
      this.phase = 'anti-fake-kickoff';
      this.action = this.drive;
    }
    step(dt) {
      if (this.phase === 'anti-fake-kickoff') {
        this.drive.target_pos = [120 * sign(this.car.position[0]), 0, 0];
        this.finished = this.info.ball.position[1] !== 0;
      }
      this.action.step(dt);
      this.controls = Object.assign(Input(), this.action.controls);
    }
  }

  class SimpleKickoff extends Kickoff {
    constructor(car, info) { super(car, info); this.drive.target_pos = [0, sign(info.my_goal.center[1]) * 100, 0]; }
    interruptible() { return this.action === this.drive; }
    step(dt) {
      const car = this.car;
      if (this.phase === 1 && norm(car.velocity) > (Math.abs(car.position[0]) < 100 ? 1550 : 1400)) {
        this.phase = 2;
        this.action = new B.AirDodge(car, 0.1, add(car.position, car.velocity));
      }
      if (this.phase === 2) {
        this.action.controls.boost = this.action.state_timer < 0.1;
        if (car.on_ground && this.action.finished) { this.action = this.drive; this.phase = 3; }
      }
      if (this.phase === 3 && distance(car, [0, 0, 93]) < norm(car.velocity) * 0.3) {
        this.phase = 4;
        this.action = new B.AirDodge(car, 0.1, this.info.ball.position);
        this.counter_fake_kickoff();
      }
      if (this.phase === 4 && this.action.finished) this.finished = true;
      super.step(dt);
    }
  }

  class SpeedFlipDodgeKickoff extends Kickoff {
    constructor(car, info) { super(car, info); this.drive.target_pos = mul(info.my_goal.center, 0.05); this.start = car.time; }
    step(dt) {
      const car = this.car;
      if (this.phase === 1 && norm(car.velocity) > 800) {
        this.action = new B.SpeedFlip(car, local(car, this.info.ball.position)[1] < 0);
        this.phase = 2;
      }
      if (this.phase === 2 && this.action.finished && car.on_ground) { this.action = this.drive; this.drive.target_pos = [0, 0, 0]; this.phase = 3; }
      if (this.phase === 3 && groundDistance(car, [0, 0, 0]) < 500) {
        this.action = new B.AirDodge(car, 0.1, [0, 0, 0]);
        this.phase = 4;
        this.counter_fake_kickoff();
      }
      if (this.phase === 4 && this.action.finished) this.finished = true;
      if (car.time > this.start + 3.5) this.finished = true;
      super.step(dt);
    }
  }

  class DriveBackwardsToGoal extends B.Maneuver {
    constructor(car, info) { super(car); this.drive = new B.Drive(car, info.my_goal.center, 1300, true); }
    step(dt) {
      this.drive.step(dt);
      this.controls = Object.assign(Input(), this.drive.controls);
      if (groundDistance(this.car, this.drive.target_pos) < 100) this.finished = true;
    }
  }

  class HalfFlipPickup extends B.Maneuver {
    constructor(car, pad) { super(car); this.drive = new B.Drive(car, pad.position, 2300, true); this.phase = 1; this.action = this.drive; }
    interruptible() { return this.action === this.drive; }
    step(dt) {
      const car = this.car;
      if (this.phase === 1 && norm(car.velocity) > 600) { this.action = new B.HalfFlip(car); this.phase = 2; }
      if (this.phase === 2 && this.action.finished) {
        this.drive.target_pos = [0, car.position[1], 0];
        this.drive.backwards = false;
        this.action = this.drive;
        this.phase = 3;
      }
      if (this.phase === 3 && norm(car.velocity) > 1300) this.finished = true;
      this.action.step(dt);
      this.controls = Object.assign(Input(), this.action.controls);
    }
  }

  // ---------------- general_defense.py, pickup_boostpad.py ----------------
  class GeneralDefense extends B.Maneuver {
    constructor(car, info, faceTarget, distanceFromTarget, forceNearest = false) {
      super(car);
      this.info = info;
      this.face_target = faceTarget;
      const dist = Math.min(distanceFromTarget, groundDistance(faceTarget, info.my_goal.center) - 50);
      let targetPos = add(ground(faceTarget), mul(groundDirection(faceTarget, info.my_goal.center), dist));
      const nearGoal = Math.abs(car.position[1] - info.my_goal.center[1]) < 3000;
      const shift = nearGoal ? 400 : 1800;
      const points = [add(targetPos, [shift, 0, 0]), sub(targetPos, [shift, 0, 0])];
      if (Math.abs(car.position[0]) > 3000) forceNearest = true;
      targetPos = nearGoal || forceNearest ? nearestPoint(faceTarget, points) : farthestPoint(faceTarget, points);
      if (Math.abs(faceTarget[0]) < 1000 || groundDistance(car, faceTarget) < 1000) targetPos = nearestPoint(car.position, points);
      targetPos = B.Arena.clamp(targetPos, 500);
      this.travel = new B.Travel(car, targetPos);
      this.travel.finish_distance = nearGoal ? 800 : 1500;
      this.drive = new B.Drive(car);
      this.stop = new B.Stop(car);
      this.start_time = car.time;
      this.pad = null;
    }
    interruptible() { return this.travel.interruptible(); }
    step(dt) {
      const car = this.car;
      this.travel.step(dt);
      if (this.travel.finished) {
        if (angleTo(car, this.face_target) > 0.3) {
          this.drive.target_pos = this.face_target;
          this.drive.target_speed = 1000;
          this.drive.step(dt);
          this.controls = Object.assign(Input(), this.drive.controls);
          this.controls.handbrake = false;
        } else {
          this.stop.step(dt);
          this.controls = Object.assign(Input(), this.stop.controls);
        }
      } else {
        this.pad = null;
        if (car.boost < 90 && this.travel.interruptible()) {
          const toTarget = groundDirection(car, this.travel.target);
          for (const pad of this.info.large_boost_pads.concat(this.info.small_boost_pads)) {
            if (pad.active && distance(car, pad) < 1200 && M.angleBetween(toTarget, groundDirection(car, pad)) < 0.5) {
              this.pad = pad;
              this.drive.target_pos = pad.position;
              this.drive.target_speed = 2200;
              this.drive.step(dt);
              this.controls = Object.assign(Input(), this.drive.controls);
              break;
            }
          }
        }
        if (!this.pad) this.controls = Object.assign(Input(), this.travel.controls);
      }
      if (car.boost < 100 && groundDistance(car, this.travel.target) < 4000) this.controls.boost = false;
      this.finished = this.travel.driving && car.time > this.start_time + 0.5;
    }
  }

  class PickupBoostPad extends B.Maneuver {
    constructor(car, pad) { super(car); this.pad = pad; this.pad_was_active = pad.active; this.travel = new B.Travel(car, pad.position, true); }
    interruptible() { return this.travel.interruptible(); }
    step(dt) {
      if (distance(this.car, this.pad) < norm(this.car.velocity) * 0.2) this.travel.drive.target_speed = 1400;
      this.travel.step(dt);
      this.controls = Object.assign(Input(), this.travel.controls);
      if (this.pad_was_active && !this.pad.active) this.finished = true;
      this.pad_was_active = this.pad.active;
      if (this.car.boost > 99 || distance(this.car, this.pad) < 100) this.finished = true;
    }
  }

  // ---------------- strategy ----------------
  function choosePad(info, car, forbidden = new Set()) {
    const valid = new Set(info.large_boost_pads.filter(p => p.active));
    info.large_boost_pads.forEach(p => { if (B.estimateTime(car, p.position) * 0.7 > p.timer && !forbidden.has(p)) valid.add(p); });
    if (!valid.size) return null;
    const target = mul(add(add(info.ball.position, mul(car.position, 2)), mul(info.my_goal.center, 2)), 1 / 5);
    return minBy([...valid], p => distance(p.position, target));
  }

  const isOpponentClose = (info, dist) => info.get_opponents().some(o => groundDistance(add(o.position, mul(o.velocity, 0.5)), info.ball) < dist);

  function directShot(info, car, target) {
    const dodge = new DodgeStrike(car, info, target).start();
    const groundShot = new GroundStrike(car, info, target).start();
    if (car.boost > 40) {
      const fast = new FastAerialStrike(car, info, target).start();
      if (fast.intercept.time < dodge.intercept.time && fast.intercept.time - info.time < car.boost / 33 &&
          Math.abs(fast.intercept.position[1] - info.their_goal.center[1]) > 500) {
        return groundDistance(fast.intercept, info.their_goal.center) < 3000 ? new DoubleTouch(fast) : fast;
      }
    }
    if (dodge.intercept.time < groundShot.intercept.time - 0.1 || groundDistance(dodge.intercept, target) < 4000 ||
        distance(groundShot.intercept.ball.velocity, car.velocity) < 500 || isOpponentClose(info, 300)) {
      if (groundDistance(dodge.intercept, target) < 4000 && Math.abs(dodge.intercept.ground_pos[0]) < 2000) return new CloseShot(car, info, target).start();
      return dodge;
    }
    return groundShot;
  }

  function anyShot(info, car, target, intercept, allowDribble = false) {
    const ball = intercept.ball;
    if (allowDribble && (ball.position[2] > 100 || Math.abs(ball.velocity[2]) > 250 || distance(car, info.ball) < 300) &&
        Math.abs(ball.velocity[2]) < 700 && groundDistance(car, ball) < 1500 && groundDistance(ball, info.my_goal.center) > 1000 &&
        groundDistance(ball, info.their_goal.center) > 1000 && !isOpponentClose(info, info.ball.position[2] * 2 + 1000)) {
      return new CarryAndFlick(car, info, target);
    }
    const direct = directShot(info, car, target);
    if (!(direct instanceof GroundStrike) && intercept.time < car.time + 4 &&
        align(car.position, ball, target) < -0.3 && Math.abs(ball.position[1] - target[1]) > 3000) {
      return new MirrorStrike(car, info, target).start();
    }
    return direct;
  }

  function anyClear(info, car) {
    const clears = [new DodgeClear(car, info).start()];
    if (car.boost > 40) clears.push(new FastAerialClear(car, info).start());
    return minBy(clears, c => c.intercept.time);
  }

  const chooseKickoff = (info, car) => (Math.abs(car.position[0]) > 1000 ? new SpeedFlipDodgeKickoff(car, info) : new SimpleKickoff(car, info));
  const isKickoff = info => info.ball.position[0] === 0 && info.ball.position[1] === 0;

  // strategy/solo_strategy.py
  function soloChoose(info, car) {
    const theirGoal = ground(info.their_goal.center), myGoal = ground(info.my_goal.center);
    if (!car.on_ground) return new B.Recovery(car);
    if (isKickoff(info)) return chooseKickoff(info, car);
    info.predict_ball();
    const mine = new B.Intercept(car, info.ball_predictions);
    const opponents = info.get_opponents();
    const theirs = opponents.length ? minBy(opponents.map(o => new B.Intercept(o, info.ball_predictions)), i => i.time) : null;
    const banned = new Set(info.large_boost_pads.filter(p => (Math.abs(p.position[1] - theirGoal[1]) < Math.abs(mine.position[1] - theirGoal[1]) ||
      Math.abs(p.position[0] - car.position[0]) > 6000) && groundDistance(car, p) < 4000));
    const pad = choosePad(info, car, banned);
    if (groundDistance(mine, myGoal) < 3000 && (Math.abs(mine.position[0]) < 2000 || Math.abs(mine.position[1]) < 4500) && car.position[2] < 300) {
      if (align(car.position, mine.ball, theirGoal) > 0.5) return anyShot(info, car, theirGoal, mine, true);
      return anyClear(info, car);
    }
    if (car.boost < 10 && groundDistance(mine, theirGoal) > 3000 && pad) return new PickupBoostPad(car, pad);
    const inTheirHalf = Math.abs(mine.position[1] - theirGoal[1]) < 3000;
    if (theirs) {
      const opp = theirs.car;
      if (theirs.time < mine.time && align(opp.position, theirs.ball, myGoal) > -0.1 + opp.boost / 100 &&
          groundDistance(opp, theirs) > 300 && dot(opp.velocity, groundDirection(theirs, myGoal)) > 0) {
        return new GeneralDefense(car, info, mine.position, 3000, inTheirHalf);
      }
    }
    if (align(car.position, mine.ball, theirGoal) > -0.5 || groundDistance(mine, theirGoal) < 2000 || (theirs && groundDistance(theirs.car, theirs) < 300)) {
      if (car.position[2] < 300) {
        const shot = anyShot(info, car, theirGoal, mine, true);
        if (!(shot instanceof Strike) || !theirs || shot.intercept.time < theirs.time || Math.abs(shot.intercept.position[0]) < 3500) return shot;
      }
    }
    if (car.boost < 30 && pad) return new PickupBoostPad(car, pad);
    return new GeneralDefense(car, info, mine.position, 3000, inTheirHalf);
  }

  // strategy/teamplay_strategy.py
  function teamplayChoose(info, car) {
    const teammates = info.get_teammates(car), team = [car].concat(teammates);
    const theirGoal = ground(info.their_goal.center), myGoal = ground(info.my_goal.center);
    if (!car.on_ground) return new B.Recovery(car);
    if (isKickoff(info) && distance(car, info.ball) === Math.min(...team.map(c => distance(c, info.ball)))) return chooseKickoff(info, car);
    if (car.boost < 20) {
      const pad = choosePad(info, car);
      if (pad) return new PickupBoostPad(car, pad);
    }
    info.predict_ball();
    const mine = new B.Intercept(car, info.ball_predictions);
    const ours = teammates.map(m => new B.Intercept(m, info.ball_predictions)).concat([mine]);
    const good = ours.filter(i => align(i.car.position, i.ball, theirGoal) > 0);
    let best;
    if (good.length) best = minBy(good, i => i.time);
    else {
      best = minBy(ours, i => distance(i.car, myGoal));
      if (groundDistance(car, myGoal) < 2000) best = mine;
    }
    if (best === mine) {
      if (align(car.position, mine.ball, theirGoal) > 0 || groundDistance(mine, myGoal) > 6000) return anyShot(info, car, theirGoal, mine);
      return anyClear(info, car);
    }
    if (minBy(team, c => distance(c, myGoal)) === car) return new GeneralDefense(car, info, mine.position, 7000);
    return new GeneralDefense(car, info, mine.position, 4000);
  }

  // strategy/hivemind_strategy.py
  class HivemindStrategy {
    constructor(info) { this.info = info; this.drone_going_for_ball = null; this.defending_drone = null; this.boost_reservations = new Map(); }

    set_kickoff_maneuvers(drones) {
      const info = this.info;
      const nearest = minBy(drones, d => groundDistance(d.car, info.ball));
      nearest.maneuver = chooseKickoff(info, nearest.car);
      this.drone_going_for_ball = nearest;
      this.boost_reservations.clear();
      const corner = drones.filter(d => Math.abs(d.car.position[0]) > 2000);
      if (corner.length > 1) {
        const other = corner.find(d => d !== nearest);
        if (other) {
          const pad = minBy(info.large_boost_pads, p => distance(other.car, p));
          other.maneuver = new HalfFlipPickup(other.car, pad);
          this.boost_reservations.set(other, pad);
        }
      }
      this.defending_drone = minBy(drones, d => -groundDistance(d.car, info.ball));
      this.defending_drone.maneuver = new DriveBackwardsToGoal(this.defending_drone.car, info);
      drones.forEach(d => { if (!corner.includes(d) && d !== this.defending_drone && d !== this.drone_going_for_ball) this.send_drone_for_boost(d); });
    }

    send_drone_for_boost(drone) {
      const pad = choosePad(this.info, drone.car, new Set(this.boost_reservations.values()));
      if (!pad) return;
      drone.maneuver = new PickupBoostPad(drone.car, pad);
      this.boost_reservations.set(drone, pad);
    }

    set_maneuvers(drones) {
      const info = this.info, theirGoal = ground(info.their_goal.center), ourGoal = ground(info.my_goal.center);
      if (this.drone_going_for_ball && !this.drone_going_for_ball.maneuver) this.drone_going_for_ball = null;
      if (this.defending_drone && !this.defending_drone.maneuver) this.defending_drone = null;
      drones.forEach(d => { if (!d.maneuver && !d.car.on_ground) d.maneuver = new B.Recovery(d.car); });
      if (!this.drone_going_for_ball) {
        const ready = drones.filter(d => !d.car.demolished && (!d.maneuver || d.maneuver.interruptible()) && d.car.position[2] < 300);
        if (!ready.length) return;
        info.predict_ball();
        const ours = ready.map(d => new B.Intercept(d.car, info.ball_predictions));
        const good = ours.filter(i => align(i.car.position, i.ball, theirGoal) > 0.3 && groundDistance(i.car, i) > 2000);
        const best = good.length ? minBy(good, i => i.time) : minBy(ours, i => groundDistance(i.car, ourGoal));
        this.drone_going_for_ball = ready.find(d => d.car === best.car);
        this.drone_going_for_ball.maneuver = align(best.car.position, best.ball, theirGoal) > 0 || groundDistance(best, ourGoal) > 6000
          ? anyShot(info, best.car, theirGoal, best) : anyClear(info, best.car);
        if (this.drone_going_for_ball === this.defending_drone) this.defending_drone = null;
      }
      drones.forEach(d => { if (!(d.maneuver instanceof PickupBoostPad)) this.boost_reservations.delete(d); });
      drones.forEach(d => { if (!d.maneuver && d.car.boost < 30) this.send_drone_for_boost(d); });
      const unemployed = drones.filter(d => !d.maneuver);
      if (unemployed.length && !this.defending_drone) {
        this.defending_drone = minBy(unemployed, d => groundDistance(d.car, info.my_goal.center));
        this.defending_drone.maneuver = new GeneralDefense(this.defending_drone.car, info, info.ball.position, 7000);
        unemployed.splice(unemployed.indexOf(this.defending_drone), 1);
      }
      unemployed.forEach(d => { d.maneuver = new GeneralDefense(d.car, info, info.ball.position, 4000); });
    }

    avoid_demos_and_team_bumps(drones) {
      const byIndex = new Map(drones.map(d => [d.car.index, d]));
      for (const [i1, i2] of this.info.detect_collisions(0.2, 1 / 60)) {
        const d1 = byIndex.get(i1), d2 = byIndex.get(i2);
        if (d1 && d2) {
          const hop = d1 === this.drone_going_for_ball ? d2 : d1;
          hop.controls.jump = hop.car.on_ground;
        } else if (d1 && norm(this.info.cars[i2].velocity) > 2000) d1.controls.jump = d1.car.on_ground;
        else if (d2 && norm(this.info.cars[i1].velocity) > 2000) d2.controls.jump = d2.car.on_ground;
      }
    }
  }

  // ---------------- bots ----------------
  const toControls = c => ({
    throttle: clamp(+c.throttle || 0, -1, 1), steer: clamp(+c.steer || 0, -1, 1), pitch: clamp(+c.pitch || 0, -1, 1),
    yaw: clamp(+c.yaw || 0, -1, 1), roll: clamp(+c.roll || 0, -1, 1), jump: !!c.jump, boost: !!c.boost, handbrake: !!c.handbrake
  });

  let warned = false;
  const reportError = e => { if (!warned) { warned = true; console.warn('Botimus error (the bot resets its plan)', e); } };

  // Whether a car other than `exclude` (index) or on another team (`team`) touched the ball since last check
  function touchedSince(world, seen, test) {
    let touched = false;
    world.cars.forEach((c, i) => {
      if (c.lastBallTouchTick === undefined || seen.get(c.id) === c.lastBallTouchTick) return;
      seen.set(c.id, c.lastBallTouchTick);
      if (test(c, i)) touched = true;
    });
    return touched;
  }

  // agent.py
  class BotimusBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Botimus Prime';
      this.controls = toControls(Input());
      this.seen = new Map();
      this.reset();
    }
    get ready() { return true; }
    reset() { this.maneuver = null; touchedSince(this.world, this.seen, () => false); }
    tick() {
      const w = this.world, me = w.cars[this.index];
      try {
        const info = B.gameInfo(w, me.team === 'orange' ? 1 : 0), car = info.cars[this.index];
        if (me.isDemoed) { this.maneuver = null; return (this.controls = toControls(Input())); }
        if (w.kickoffPause && !(this.maneuver instanceof Kickoff)) this.maneuver = null;
        if (touchedSince(w, this.seen, (c, i) => i !== this.index) && this.maneuver && this.maneuver.interruptible()) this.maneuver = null;
        if (!this.maneuver) this.maneuver = info.get_teammates(car).length ? teamplayChoose(info, car) : soloChoose(info, car);
        if (this.maneuver) {
          this.maneuver.step(info.time_delta);
          this.controls = toControls(this.maneuver.controls);
          if (this.maneuver.finished) this.maneuver = null;
        }
      } catch (e) {
        reportError(e);
        this.maneuver = null;
      }
      return this.controls;
    }
  }

  // hivemind.py: one hive per team drives every Bumblebee on that team
  const hives = new WeakMap();
  class Beehive {
    constructor(world, team) { this.world = world; this.team = team; this.drones = []; this.tick = -1; this.strategy = null; this.seen = new Map(); }
    add(index) { const d = { index, controls: Input(), maneuver: null, car: null }; this.drones.push(d); return d; }
    update() {
      const w = this.world;
      if (this.tick === w.tickCount) return;
      this.tick = w.tickCount;
      const info = B.gameInfo(w, this.team);
      this.drones.forEach(d => { d.car = info.cars[d.index]; });
      if (!this.strategy) this.strategy = new HivemindStrategy(info);
      this.strategy.info = info;
      const drones = this.drones;
      if (w.kickoffPause && isKickoff(info) && !drones.some(d => d.maneuver instanceof Kickoff)) {
        if (drones.length === 1) drones[0].maneuver = null; else this.strategy.set_kickoff_maneuvers(drones);
      }
      if (touchedSince(w, this.seen, c => (c.team === 'orange' ? 1 : 0) !== this.team)) {
        drones.forEach(d => { if (d.maneuver && d.maneuver.interruptible()) d.maneuver = null; });
      }
      drones.forEach(d => { if (d.maneuver && d.car.demolished) d.maneuver = null; });
      if (drones.some(d => !d.maneuver)) {
        if (drones.length === 1) drones[0].maneuver = teamplayChoose(info, drones[0].car);
        else this.strategy.set_maneuvers(drones);
      }
      drones.forEach(d => {
        if (!d.maneuver) return;
        d.maneuver.step(info.time_delta);
        d.controls = Object.assign(Input(), d.maneuver.controls);
        if (d.maneuver.finished) d.maneuver = null;
      });
      if (drones.length > 1) this.strategy.avoid_demos_and_team_bumps(drones);
    }
  }

  class BumblebeeBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Bumblebee';
      const team = world.cars[carIndex].team === 'orange' ? 1 : 0;
      let byTeam = hives.get(world.cars);
      if (!byTeam) hives.set(world.cars, byTeam = {});
      this.hive = byTeam[team] || (byTeam[team] = new Beehive(world, team));
      this.drone = this.hive.add(carIndex);
    }
    get ready() { return true; }
    reset() { this.drone.maneuver = null; this.drone.controls = Input(); if (this.hive.strategy) { this.hive.strategy.drone_going_for_ball = null; this.hive.strategy.defending_drone = null; } }
    tick() {
      try {
        this.hive.update();
      } catch (e) {
        reportError(e);
        this.hive.drones.forEach(d => { d.maneuver = null; d.controls = Input(); });
      }
      return toControls(this.drone.controls);
    }
  }

  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'bowie'), 0,
    { id: 'botimus', name: 'Botimus Prime', desc: 'Veteran scripted challenger by Darxeal (RLBot tournament regular since 2018). Drives fast and hits hard: speed-flip kickoffs, dodge shots, aerials with double touches, wall bounces and roof dribbles with flicks, then rotates back and shadows you on defence.',
      modes: ['1v1', '2v2', '3v3'], make: (w, i) => new BotimusBot(w, i), load: () => Promise.resolve() },
    { id: 'bumblebee', name: 'Bumblebee', desc: 'Hivemind team bot by Darxeal & Will. One mind controls every Bumblebee on a team: it splits kickoff duties, reserves boost pads, sends exactly one car for the ball and keeps a defender home. Best in 3v3, where a full team of Bumblebees rotates like a real squad.',
      modes: ['1v1', '2v2', '3v3'], make: (w, i) => new BumblebeeBot(w, i), load: () => Promise.resolve() });

  Object.assign(Game.Botimus, { BotimusBot, BumblebeeBot, Strike, DodgeStrike, GroundStrike, AerialStrike, soloChoose, teamplayChoose });
})();
