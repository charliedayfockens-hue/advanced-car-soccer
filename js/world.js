// One arena tick in RocketSim's order (Arena::Step): car pre-ticks (vehicle rays, controls, jumps,
// flips, suspension + tire impulses), gravity, damping, collision detection with RocketSim's contact
// callbacks (car-ball extra hit impulse, car-car bumps and demos, car-world contact tracking,
// special ball-world contacts), constraint solve, transform integration, car/ball end-of-tick
// velocity caps, then boost pads. Supports any number of cars (free play: 1, 1v1: 2).
window.Game = window.Game || {};

Game.World = (function () {
  const RL = Game.RL, U = RL.UU_TO_BT, BT = RL.BT_TO_UU;
  const { Vec3, Mat3, integrateTransform, clamp, SIMD_EPSILON } = Game.Math;
  const { RigidBody, Solver } = Game.Physics;
  const Arena = Game.Arena;

  const GRAVITY = new Vec3(0, 0, RL.GRAVITY_Z * U);
  const BALL_RADIUS = RL.BALL_COLLISION_RADIUS_SOCCAR * U;
  const BALL_WORLD_MARGIN = Game.ArenaGeom.ballWorldMargin * U;
  // Contact breaking thresholds: bounding-sphere "angular motion disc" * gContactBreakingThreshold (0.02)
  const BALL_CONTACT_THRESHOLD = BALL_RADIUS * Math.sqrt(3) * 0.02;
  const CAR_CONTACT_THRESHOLD = 0.042;
  const BOX_MARGIN = 0.04;
  const IDLE = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };

  function sdfBT(p) { return Arena.sdf(p.x * BT, p.y * BT, p.z * BT) * U; }
  function normalAt(p) { const n = Arena.normal(p.x * BT, p.y * BT, p.z * BT); return new Vec3(n.x, n.y, n.z); }

  class World {
    constructor() {
      this.tickTime = 1 / RL.TICK_RATE;
      this.tickCount = 0;

      const ballInertia = 0.4 * RL.BALL_MASS_BT * BALL_RADIUS * BALL_RADIUS;
      this.ball = new RigidBody({
        mass: RL.BALL_MASS_BT,
        inertia: new Vec3(ballInertia, ballInertia, ballInertia),
        friction: RL.BALL_FRICTION,
        restitution: RL.BALL_RESTITUTION,
        linearDamping: RL.BALL_DRAG
      });
      this.ballRadius = BALL_RADIUS;

      this.solver = new Solver();
      this.warmStart = new Map();
      this.events = [];
      this.boostMode = 'unlimited';
      this.kickoffPause = false;
      this.nextCarId = 1;

      const BP = Game.BoostPads;
      this.boostPads = BP.BIG.map(p => ({ pos: new Vec3(p[0] * U, p[1] * U, p[2] * U), isBig: true }))
        .concat(BP.SMALL.map(p => ({ pos: new Vec3(p[0] * U, p[1] * U, p[2] * U), isBig: false })));
      this.boostPads.forEach(pad => {
        const r = (pad.isBig ? BP.BOX_RAD_BIG : BP.BOX_RAD_SMALL) * U;
        pad.boxMin = pad.pos.sub(new Vec3(r, r, 0));
        pad.boxMax = pad.pos.add(new Vec3(r, r, BP.BOX_HEIGHT * U));
      });

      this.setTeams(['blue']);
      this.resetKickoff(4);
    }

    // Replace the cars: teams is e.g. ['blue'] or ['blue', 'orange']
    setTeams(teams) {
      this.cars = teams.map(team => {
        const car = new Game.CarSim(Game.CarConfigOctane);
        car.team = team;
        car.id = this.nextCarId++;
        car.isDemoed = false;
        car.demoTimer = 0;
        car.carContact = { otherId: 0, cooldown: 0 };
        car.boostUsedPerSecond = this.boostMode === 'standard' ? Game.BoostPads.BOOST_USED_PER_SECOND : 0;
        return car;
      });
      this.car = this.cars[0];
      this.carSamples = this.buildBoxSamples();
      this.warmStart.clear();
    }

    // Surface sample points of the car hitbox (local to the hitbox center, BT)
    buildBoxSamples() {
      const he = this.cars[0].hitboxHalf;
      const nx = 6, ny = 4, nz = 2, pts = [];
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
          for (let k = 0; k <= nz; k++) {
            if (i !== 0 && i !== nx && j !== 0 && j !== ny && k !== 0 && k !== nz) continue;
            pts.push(new Vec3(-he.x + 2 * he.x * i / nx, -he.y + 2 * he.y * j / ny, -he.z + 2 * he.z * k / nz));
          }
        }
      }
      return pts;
    }

    // Arena::ResetToRandomKickoff: each team's cars take shuffled kickoff spots, orange mirrored
    resetKickoff(spawnIndex) {
      const spawns = RL.CAR_SPAWN_LOCATIONS_SOCCAR;
      const order = [0, 1, 2, 3, 4];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      if (spawnIndex !== undefined) { order.splice(order.indexOf(spawnIndex), 1); order.unshift(spawnIndex); }
      const startBoost = this.boostMode === 'standard' ? 100 / 3 : RL.BOOST_MAX;

      ['blue', 'orange'].forEach(team => {
        this.cars.filter(c => c.team === team).forEach((car, i) => {
          const s = spawns[order[i % spawns.length]];
          const sign = team === 'blue' ? 1 : -1;
          car.setState(new Vec3(s.x * sign * U, s.y * sign * U, RL.CAR_SPAWN_REST_Z * U), s.yaw + (team === 'blue' ? 0 : Math.PI));
          car.state.boost = startBoost;
          car.isDemoed = false;
          car.demoTimer = 0;
          car.carContact = { otherId: 0, cooldown: 0 };
        });
      });

      const ball = this.ball;
      ball.pos = new Vec3(0, 0, RL.BALL_REST_Z * U);
      ball.rot = new Mat3();
      ball.linVel = new Vec3();
      ball.angVel = new Vec3();
      ball.velocityImpulseCache = new Vec3();
      ball.updateInertiaTensor();
      ball.clearForces();
      this.warmStart.clear();
      this.kickoffPause = true;
      this.boostPads.forEach(pad => { pad.cooldown = 0; pad.isActive = true; pad.prevLockedId = 0; });
    }

    setBoostMode(mode) {
      this.boostMode = mode;
      this.cars.forEach(car => {
        car.boostUsedPerSecond = mode === 'standard' ? Game.BoostPads.BOOST_USED_PER_SECOND : 0;
        if (mode !== 'standard') car.state.boost = RL.BOOST_MAX;
      });
    }

    // Car::Demolish / Car::Respawn
    demolish(car) {
      car.isDemoed = true;
      car.demoTimer = RL.DEMO_RESPAWN_TIME;
      car.body.linVel = new Vec3();
      car.body.angVel = new Vec3();
    }

    respawn(car) {
      const locs = RL.CAR_RESPAWN_LOCATIONS_SOCCAR;
      const s = locs[Math.floor(Math.random() * locs.length)];
      const sign = car.team === 'blue' ? 1 : -1;
      car.setState(new Vec3(s.x * U, s.y * sign * U, RL.CAR_RESPAWN_Z * U), s.yaw + (car.team === 'blue' ? 0 : Math.PI));
      car.state.boost = this.boostMode === 'standard' ? 100 / 3 : RL.BOOST_MAX;
      car.isDemoed = false;
      car.demoTimer = 0;
    }

    // BoostPad::_PreTickUpdate / _CheckCollide / _PostTickUpdate
    updateBoostPads(dt) {
      const BP = Game.BoostPads;
      for (const pad of this.boostPads) {
        if (pad.cooldown > 0) pad.cooldown = Math.max(pad.cooldown - dt, 0);
        pad.isActive = pad.cooldown === 0;
        pad.curLocked = null;
      }
      this.cars.forEach((car, ci) => {
        if (car.isDemoed) return;
        const body = car.body;
        let aabb = null;
        for (const pad of this.boostPads) {
          let colliding = false;
          if (pad.prevLockedId === car.id) {
            aabb = aabb || this.carAabb(car);
            colliding = pad.boxMax.x > aabb.min.x && pad.boxMax.y > aabb.min.y && pad.boxMax.z > aabb.min.z &&
                        pad.boxMin.x < aabb.max.x && pad.boxMin.y < aabb.max.y && pad.boxMin.z < aabb.max.z;
          } else {
            const rad = (pad.isBig ? BP.CYL_RAD_BIG : BP.CYL_RAD_SMALL) * U;
            const dx = body.pos.x - pad.pos.x, dy = body.pos.y - pad.pos.y;
            if (dx * dx + dy * dy < rad * rad) colliding = Math.abs(body.pos.z - pad.pos.z) < BP.CYL_HEIGHT * U;
          }
          if (colliding) { pad.curLocked = car; pad.curLockedIndex = ci; }
        }
      });
      for (const pad of this.boostPads) {
        let lockedId = 0;
        if (pad.curLocked) {
          lockedId = pad.curLocked.id;
          if (pad.isActive) {
            const s = pad.curLocked.state;
            s.boost = Math.min(s.boost + (pad.isBig ? BP.BOOST_AMOUNT_BIG : BP.BOOST_AMOUNT_SMALL), RL.BOOST_MAX);
            pad.isActive = false;
            pad.cooldown = pad.isBig ? BP.COOLDOWN_BIG : BP.COOLDOWN_SMALL;
            this.events.push({ type: 'boostPickup', big: pad.isBig, car: pad.curLockedIndex });
          }
        }
        pad.prevLockedId = lockedId;
      }
    }

    carAabb(car) {
      const body = car.body;
      const center = body.pos.add(body.rot.mulVec(car.hitboxOffset));
      const e = body.rot.e, h = car.hitboxHalf;
      const ext = new Vec3(
        Math.abs(e[0]) * h.x + Math.abs(e[1]) * h.y + Math.abs(e[2]) * h.z,
        Math.abs(e[3]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[5]) * h.z,
        Math.abs(e[6]) * h.x + Math.abs(e[7]) * h.y + Math.abs(e[8]) * h.z
      );
      return { min: center.sub(ext), max: center.add(ext) };
    }

    // Training "ball control" helpers (player car)
    ballControl(kind) {
      const car = this.car, body = car.body, ball = this.ball;
      const f = body.rot.col(0);
      const f2 = new Vec3(f.x, f.y, 0).normalized();
      const dir = f2.isZero() ? new Vec3(1, 0, 0) : f2;
      ball.angVel = new Vec3();
      ball.velocityImpulseCache = new Vec3();
      if (kind === 'takePossession') {
        ball.pos = body.pos.add(dir.mul((car.hitboxOffset.x + car.hitboxHalf.x) + BALL_RADIUS + 60 * U));
        ball.pos.z = Math.max(ball.pos.z, RL.BALL_REST_Z * U);
        ball.linVel = body.linVel.clone();
      } else if (kind === 'startDribble') {
        const up = body.rot.col(2);
        ball.pos = body.pos.add(up.mul(car.hitboxOffset.z + car.hitboxHalf.z + BALL_RADIUS + 8 * U)).add(f.mul(5 * U));
        ball.linVel = body.linVel.clone();
      } else if (kind === 'passBall') {
        const target = body.pos.add(body.linVel.mul(0.6)).add(dir.mul(250 * U));
        const d = target.sub(ball.pos);
        d.z = Math.max(d.z, (RL.BALL_REST_Z + 40) * U - ball.pos.z);
        const T = Math.min(Math.max(Math.hypot(d.x, d.y) * BT / 1800, 0.6), 1.6);
        ball.linVel = new Vec3(d.x / T, d.y / T, d.z / T - 0.5 * GRAVITY.z * T);
      } else if (kind === 'launchBall') {
        ball.pos.z = Math.max(ball.pos.z, RL.BALL_REST_Z * U);
        ball.linVel = new Vec3(0, 0, 1300 * U);
      }
      if (ball.linVel.isZero()) ball.linVel.z = 1e-6;
      this.kickoffPause = false;
      this.warmStart.forEach((v, k) => { if (k.startsWith('cb') || k === 'bw') this.warmStart.delete(k); });
    }

    // btDefaultVehicleRaycaster::castRay against the arena, the ball and other cars (BT units)
    rayCast(from, dir, length, ignoreCar) {
      let best = null;

      const hit = Arena.rayCast(from.x * BT, from.y * BT, from.z * BT, dir.x, dir.y, dir.z, length * BT);
      if (hit) {
        best = {
          fraction: hit.t * U / length,
          point: new Vec3(hit.point.x * U, hit.point.y * U, hit.point.z * U),
          normal: new Vec3(hit.normal.x, hit.normal.y, hit.normal.z),
          body: null
        };
      }

      const oc = from.sub(this.ball.pos);
      const b = oc.dot(dir), c = oc.length2() - BALL_RADIUS * BALL_RADIUS;
      if (c > 0) {
        const disc = b * b - c;
        if (disc >= 0) {
          const t = -b - Math.sqrt(disc);
          if (t >= 0 && t <= length && (!best || t / length < best.fraction)) {
            const point = from.add(dir.mul(t));
            best = { fraction: t / length, point, normal: point.sub(this.ball.pos).mul(1 / BALL_RADIUS), body: this.ball };
          }
        }
      }

      for (const other of this.cars) {
        if (other === ignoreCar || other.isDemoed) continue;
        const r = rayBox(from, dir, length, other);
        if (r && (!best || r.t / length < best.fraction)) {
          best = { fraction: r.t / length, point: from.add(dir.mul(r.t)), normal: r.normal, body: other.body };
        }
      }
      return best;
    }

    carWorldContacts(car, ci, out) {
      const body = car.body;
      const center = body.pos.add(body.rot.mulVec(car.hitboxOffset));
      if (sdfBT(center) > car.hitboxHalf.length() + CAR_CONTACT_THRESHOLD) return;

      const candidates = [];
      this.carSamples.forEach((local, index) => {
        const p = center.add(body.rot.mulVec(local));
        const d = sdfBT(p);
        if (d < CAR_CONTACT_THRESHOLD) candidates.push({ p, d, index });
      });
      if (!candidates.length) return;

      for (const c of reduceContacts(candidates)) {
        const n = normalAt(c.p);
        const contact = {
          a: body, b: null, normal: n, pointA: c.p, pointB: c.p.sub(n.mul(c.d)), distance: c.d,
          friction: RL.CARWORLD_COLLISION_FRICTION, restitution: RL.CARWORLD_COLLISION_RESTITUTION,
          key: 'cw' + ci + '_' + c.index
        };
        // Arena::_BtCallback_OnCarWorldCollision
        car.state.worldContact.hasContact = true;
        car.state.worldContact.contactNormal = n;
        if (!this.warmStart.has(contact.key)) {
          const vn = -body.velocityAt(c.p.sub(body.pos)).dot(n) * BT;
          if (vn > 250) this.events.push({ type: 'carImpact', strength: vn, car: ci });
        }
        out.push(contact);
      }
    }

    // btSphereBoxCollisionAlgorithm::getSphereDistance
    carBallContact(car, ci, out) {
      const body = car.body, ball = this.ball;
      const center = body.pos.add(body.rot.mulVec(car.hitboxOffset));
      const he = car.hitboxHalf.sub(new Vec3(BOX_MARGIN, BOX_MARGIN, BOX_MARGIN));
      const rel = body.rot.tmulVec(ball.pos.sub(center));

      let closest = new Vec3(clamp(rel.x, -he.x, he.x), clamp(rel.y, -he.y, he.y), clamp(rel.z, -he.z, he.z));
      const intersectionDist = BALL_RADIUS + BOX_MARGIN;
      const contactDist = intersectionDist + BALL_CONTACT_THRESHOLD;
      let n = rel.sub(closest);
      const dist2 = n.length2();
      if (dist2 > contactDist * contactDist) return false;

      let distance;
      if (dist2 <= SIMD_EPSILON) {
        const pen = spherePenetration(he, rel);
        closest = pen.closest;
        n = pen.normal;
        distance = -pen.dist;
      } else {
        distance = Math.sqrt(dist2);
        n = n.mul(1 / distance);
      }
      const depth = distance - intersectionDist;
      const pointOnCar = center.add(body.rot.mulVec(closest.add(n.mul(BOX_MARGIN))));
      const nWorld = body.rot.mulVec(n); // car -> ball

      out.push({
        a: body, b: ball, normal: nWorld.neg(), pointA: pointOnCar, pointB: pointOnCar.add(nWorld.mul(depth)), distance: depth,
        friction: RL.CARBALL_COLLISION_FRICTION, restitution: RL.CARBALL_COLLISION_RESTITUTION,
        key: 'cb' + ci
      });
      this.onCarBallHit(car, ci);
      return true;
    }

    // Ball::_OnHit extra impulse (applied through the velocity cache at the end of the tick)
    onCarBallHit(car, ci) {
      const ball = this.ball, tick = this.tickCount;
      this.kickoffPause = false;
      car.lastBallTouchTick = tick;
      if (!(tick > car.ballHitTickApplied + 1 || car.ballHitTickApplied > tick)) return;
      car.ballHitTickApplied = tick;

      const carForward = car.body.rot.col(0);
      const relPos = ball.pos.sub(car.body.pos).mul(BT);
      const relVel = ball.linVel.sub(car.body.linVel).mul(BT);
      const relSpeed = Math.min(relVel.length(), RL.BALL_CAR_EXTRA_IMPULSE_MAXDELTAVEL_UU);
      if (relSpeed > 0) {
        let hitDir = relPos.mulVec(new Vec3(1, 1, RL.BALL_CAR_EXTRA_IMPULSE_Z_SCALE)).normalized();
        const forwardAdjustment = carForward.mul(hitDir.dot(carForward) * (1 - RL.BALL_CAR_EXTRA_IMPULSE_FORWARD_SCALE));
        hitDir = hitDir.sub(forwardAdjustment).normalized();
        const addedVel = hitDir.mul(relSpeed * RL.BALL_CAR_EXTRA_IMPULSE_FACTOR_CURVE(relSpeed));
        ball.velocityImpulseCache.addLocal(addedVel.mul(U));
      }
      if (!this.warmStart.has('cb' + ci)) this.events.push({ type: 'ballHit', strength: relSpeed, car: ci });
    }

    // Box-box contacts: surface samples of each hitbox tested against the other box
    carCarContacts(ia, ib, out) {
      const A = this.cars[ia], B = this.cars[ib];
      const ca = A.body.pos.add(A.body.rot.mulVec(A.hitboxOffset));
      const cb = B.body.pos.add(B.body.rot.mulVec(B.hitboxOffset));
      const reach = A.hitboxHalf.length() + B.hitboxHalf.length() + CAR_CONTACT_THRESHOLD;
      if (ca.sub(cb).length2() > reach * reach) return;

      const touching = [];
      const test = (P, Q, cp, cq, pi, qi) => {
        const cand = [];
        const h = Q.hitboxHalf;
        this.carSamples.forEach((local, index) => {
          const p = cp.add(P.body.rot.mulVec(local));
          const q = Q.body.rot.tmulVec(p.sub(cq));
          const dx = h.x - Math.abs(q.x), dy = h.y - Math.abs(q.y), dz = h.z - Math.abs(q.z);
          if (dx < -CAR_CONTACT_THRESHOLD || dy < -CAR_CONTACT_THRESHOLD || dz < -CAR_CONTACT_THRESHOLD) return;
          let d = dx, nl = new Vec3(q.x < 0 ? -1 : 1, 0, 0);
          if (dy < d) { d = dy; nl = new Vec3(0, q.y < 0 ? -1 : 1, 0); }
          if (dz < d) { d = dz; nl = new Vec3(0, 0, q.z < 0 ? -1 : 1); }
          cand.push({ p, d: -d, index, nl });
        });
        for (const c of reduceContacts(cand)) {
          const n = Q.body.rot.mulVec(c.nl); // out of Q, toward P
          out.push({
            a: P.body, b: Q.body, normal: n, pointA: c.p, pointB: c.p.sub(n.mul(c.d)), distance: c.d,
            friction: RL.CARCAR_COLLISION_FRICTION, restitution: RL.CARCAR_COLLISION_RESTITUTION,
            key: 'cc' + pi + '_' + qi + '_' + c.index
          });
          touching.push(c.p);
        }
      };
      test(A, B, ca, cb, ia, ib);
      test(B, A, cb, ca, ib, ia);
      if (touching.length) this.onCarCarCollision(A, B, ia, ib, touching);
    }

    // Arena::_BtCallback_OnCarCarCollision: bumps and demos
    onCarCarCollision(car1, car2, i1, i2, points) {
      const pairs = [[car1, car2, i1, i2], [car2, car1, i2, i1]];
      for (const [c1, c2, a, b] of pairs) {
        if (c1.isDemoed || c2.isDemoed) return;
        if (c1.carContact.otherId === c2.id && c1.carContact.cooldown > 0) continue;
        const s1 = c1.body, s2 = c2.body;
        const deltaPos = s2.pos.sub(s1.pos);
        if (s1.linVel.dot(deltaPos) <= 0) continue;
        const velDir = s1.linVel.normalized();
        const dirToOther = deltaPos.normalized();
        const speedTowards = s1.linVel.dot(dirToOther) * BT;
        const otherAway = s2.linVel.dot(velDir) * BT;
        if (speedTowards <= otherAway) continue;

        const hitWithBumper = points.some(p => s1.rot.tmulVec(p.sub(s1.pos)).x * BT > RL.BUMP_MIN_FORWARD_DIST);
        if (!hitWithBumper) continue;

        // demoImmune: set by bots that can't be demolished (Mirror Bot, Bowie Knife 99); they still get bumped
        const isDemo = c1.state.isSupersonic && c1.team !== c2.team && !c2.demoImmune;
        if (isDemo) {
          this.demolish(c2);
          this.events.push({ type: 'demo', attacker: a, victim: b });
        } else {
          const groundHit = c2.state.isOnGround;
          const baseScale = (groundHit ? RL.BUMP_VEL_AMOUNT_GROUND_CURVE : RL.BUMP_VEL_AMOUNT_AIR_CURVE)(speedTowards);
          const hitUpDir = groundHit ? s2.rot.col(2) : new Vec3(0, 0, 1);
          const bump = velDir.mul(baseScale).add(hitUpDir.mul(RL.BUMP_UPWARD_VEL_AMOUNT_CURVE(speedTowards)));
          s2.velocityImpulseCache.addLocal(bump.mul(U));
          this.events.push({ type: 'bump', attacker: a, victim: b, strength: speedTowards });
        }
        c1.carContact = { otherId: c2.id, cooldown: RL.BUMP_COOLDOWN_TIME };
      }
    }

    ballWorldContact(out) {
      const ball = this.ball;
      const s = sdfBT(ball.pos);
      const distance = s - BALL_RADIUS - BALL_WORLD_MARGIN;
      if (distance >= BALL_CONTACT_THRESHOLD) return;
      const n = normalAt(ball.pos);
      const pointB = ball.pos.sub(n.mul(s));
      if (!this.warmStart.has('bw')) {
        const vn = -n.dot(ball.linVel) * BT;
        if (vn > 60) this.events.push({ type: 'ballBounce', strength: vn });
      }
      out.push({
        a: ball, b: null, normal: n, pointA: pointB.add(n.mul(distance)), pointB, distance,
        friction: Math.min(RL.BALL_FRICTION, RL.ARENA_COLLISION_BASE_FRICTION),
        restitution: Math.max(RL.BALL_RESTITUTION, RL.ARENA_COLLISION_BASE_RESTITUTION),
        special: true, key: 'bw'
      });
    }

    // controls: one CarControls per car (missing entries idle)
    step(controls) {
      const dt = this.tickTime, ball = this.ball;
      const list = Array.isArray(controls) ? controls : [controls];
      let ballActive = !(ball.linVel.length2() === 0 && ball.angVel.length2() === 0);
      this.events.length = 0;

      this.cars.forEach((car, i) => {
        car.events.length = 0;
        if (car.isDemoed) {
          car.demoTimer -= dt;
          if (car.demoTimer <= 0) this.respawn(car);
          return;
        }
        car.controls = Object.assign({}, IDLE, list[i] || {});
        const wasOnGround = car.state.isOnGround;
        car.preTick(dt, this);
        // Wheels landing on the ball count as ground contact in RocketSim, which restores the flip
        if (!wasOnGround && car.state.isOnGround && car.wheels.some(w => w.inContact && w.groundBody === ball)) {
          this.events.push({ type: 'flipReset', car: i });
        }
      });
      const active = this.cars.filter(c => !c.isDemoed);

      // btDiscreteDynamicsWorld::stepSimulation
      active.forEach(car => car.body.applyCentralForce(GRAVITY.mul(car.body.mass)));
      if (ballActive) ball.applyCentralForce(GRAVITY.mul(ball.mass));
      ball.linVel.scaleLocal(Math.pow(1 - ball.linearDamping, dt));

      const contacts = [];
      this.cars.forEach((car, i) => {
        if (car.isDemoed) return;
        this.carWorldContacts(car, i, contacts);
        if (this.carBallContact(car, i, contacts)) ballActive = true;
      });
      for (let i = 0; i < this.cars.length; i++) {
        for (let j = i + 1; j < this.cars.length; j++) {
          if (!this.cars[i].isDemoed && !this.cars[j].isDemoed) this.carCarContacts(i, j, contacts);
        }
      }
      if (ballActive) this.ballWorldContact(contacts);

      for (const cp of contacts) cp.warmImpulse = this.warmStart.get(cp.key) || 0;
      const bodies = active.map(c => c.body);
      if (ballActive) bodies.push(ball);
      this.solver.solve(contacts, bodies, dt);
      this.warmStart.clear();
      for (const cp of contacts) this.warmStart.set(cp.key, cp.appliedImpulse);

      for (const body of bodies) {
        const t = integrateTransform(body.pos, body.rot, body.linVel, body.angVel, dt);
        body.pos = t.pos;
        body.rot = t.rot;
        body.updateInertiaTensor();
      }
      this.cars.forEach(car => car.body.clearForces());
      ball.clearForces();

      this.cars.forEach((car, i) => {
        if (car.isDemoed) return;
        car.postTick(dt);
        car.finishTick();
        if (car.carContact.cooldown > 0) car.carContact.cooldown = Math.max(car.carContact.cooldown - dt, 0);
        for (const e of car.events) this.events.push(Object.assign({ car: i }, e));
      });
      if (this.boostMode === 'standard') this.updateBoostPads(dt);

      // Ball::_FinishPhysicsTick
      if (!ball.velocityImpulseCache.isZero()) {
        ball.linVel.addLocal(ball.velocityImpulseCache);
        ball.velocityImpulseCache = new Vec3();
      }
      const maxSpeed = RL.BALL_MAX_SPEED * U;
      if (ball.linVel.length2() > maxSpeed * maxSpeed) ball.linVel = ball.linVel.normalized().mul(maxSpeed);
      if (ball.angVel.length2() > RL.BALL_MAX_ANG_SPEED * RL.BALL_MAX_ANG_SPEED) ball.angVel = ball.angVel.normalized().mul(RL.BALL_MAX_ANG_SPEED);

      this.tickCount++;
    }

    // Arena::IsBallScored. Returns 'blue' / 'orange' (the team that scored) or null.
    scoredGoal() {
      const y = this.ball.pos.y * BT;
      if (Math.abs(y) <= RL.SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y + RL.BALL_COLLISION_RADIUS_SOCCAR) return null;
      return y > 0 ? 'blue' : 'orange';
    }
  }

  // Slab test of a ray against a car's hitbox; ignores rays starting inside it
  function rayBox(from, dir, length, car) {
    const body = car.body, h = car.hitboxHalf;
    const center = body.pos.add(body.rot.mulVec(car.hitboxOffset));
    const o = body.rot.tmulVec(from.sub(center)), d = body.rot.tmulVec(dir);
    let tmin = 0, tmax = length, axis = -1, sign = 0, inside = true;
    const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z], Hh = [h.x, h.y, h.z];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(O[k]) > Hh[k]) inside = false;
      if (Math.abs(D[k]) < 1e-9) {
        if (Math.abs(O[k]) > Hh[k]) return null;
        continue;
      }
      let t1 = (-Hh[k] - O[k]) / D[k], t2 = (Hh[k] - O[k]) / D[k];
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = k; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (inside || axis < 0) return null;
    const nl = new Vec3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    return { t: tmin, normal: body.rot.mulVec(nl) };
  }

  // Keep at most 4 points like btPersistentManifold: deepest, then spread out for max area.
  function reduceContacts(points) {
    if (points.length <= 4) return points;
    const pool = points.slice().sort((p, q) => p.d - q.d);
    const chosen = [pool.shift()];
    const pickFarthest = score => {
      let bestI = 0, bestS = -Infinity;
      pool.forEach((p, i) => { const s = score(p); if (s > bestS) { bestS = s; bestI = i; } });
      chosen.push(pool.splice(bestI, 1)[0]);
    };
    pickFarthest(p => p.p.sub(chosen[0].p).length2());
    pickFarthest(p => p.p.sub(chosen[0].p).cross(chosen[1].p.sub(chosen[0].p)).length2());
    pickFarthest(p => Math.min(...chosen.map(c => c.p.sub(p.p).length2())));
    return chosen;
  }

  // btSphereBoxCollisionAlgorithm::getSpherePenetration
  function spherePenetration(he, rel) {
    let minDist = he.x - rel.x, closest = new Vec3(he.x, rel.y, rel.z), normal = new Vec3(1, 0, 0);
    const faces = [
      [he.x + rel.x, new Vec3(-he.x, rel.y, rel.z), new Vec3(-1, 0, 0)],
      [he.y - rel.y, new Vec3(rel.x, he.y, rel.z), new Vec3(0, 1, 0)],
      [he.y + rel.y, new Vec3(rel.x, -he.y, rel.z), new Vec3(0, -1, 0)],
      [he.z - rel.z, new Vec3(rel.x, rel.y, he.z), new Vec3(0, 0, 1)],
      [he.z + rel.z, new Vec3(rel.x, rel.y, -he.z), new Vec3(0, 0, -1)]
    ];
    for (const [d, c, n] of faces) {
      if (d < minDist) { minDist = d; closest = c; normal = n; }
    }
    return { dist: minDist, closest, normal };
  }

  return { World };
})();
