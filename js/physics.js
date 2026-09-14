// Rigid bodies and a port of the parts of Bullet 3.24 that RocketSim uses, including RocketSim's
// own solver changes: split-impulse contacts (erp2 = 0.8, penetration threshold disabled), no
// velocity-based penetration push for separated contacts, and "special" ball-world contacts that
// get averaged into a single constraint per body (btSequentialImpulseConstraintSolver.cpp).
// Bullet Physics: zlib license, Copyright (c) 2003-2006 Erwin Coumans. RocketSim: MIT, ZealanL.
window.Game = window.Game || {};

Game.Physics = (function () {
  const { Vec3, integrateTransform, planeSpace, SIMD_EPSILON } = Game.Math;
  const ZERO = new Vec3();

  const SOLVER = {
    numIterations: 10,
    erp: 0.2,
    erp2: 0.8,
    restitutionVelocityThreshold: 0.2,
    warmstartingFactor: 0.85,
    splitImpulseTurnErp: 0.1
  };

  class RigidBody {
    constructor(opts) {
      this.mass = opts.mass;
      this.invMass = 1 / opts.mass;
      const I = opts.inertia;
      this.invInertiaLocal = new Vec3(I.x ? 1 / I.x : 0, I.y ? 1 / I.y : 0, I.z ? 1 / I.z : 0);
      this.pos = new Vec3();
      this.rot = new Game.Math.Mat3();
      this.linVel = new Vec3();
      this.angVel = new Vec3();
      this.totalForce = new Vec3();
      // RocketSim only ever calls applyTorque(invInertiaWorld.inverse() * x), so torques are
      // accumulated directly as the angular acceleration x they produce.
      this.totalAngAccel = new Vec3();
      this.friction = opts.friction || 0;
      this.restitution = opts.restitution || 0;
      this.linearDamping = opts.linearDamping || 0;
      this.velocityImpulseCache = new Vec3();
      this.updateInertiaTensor();
    }

    updateInertiaTensor() { this.invInertiaWorld = this.rot.scaledTransposed(this.invInertiaLocal); }
    applyCentralForce(f) { this.totalForce.addLocal(f); }
    applyAngularAccel(a) { this.totalAngAccel.addLocal(a); }
    applyCentralImpulse(j) { this.linVel.addScaledLocal(j, this.invMass); }
    applyImpulse(j, rel) {
      this.applyCentralImpulse(j);
      this.angVel.addLocal(this.invInertiaWorld.mulVec(rel.cross(j)));
    }
    velocityAt(rel) { return this.linVel.add(this.angVel.cross(rel)); }
    computeImpulseDenominator(pos, n) {
      const r = pos.sub(this.pos);
      const vec = this.invInertiaWorld.mulVec(r.cross(n)).cross(r);
      return this.invMass + n.dot(vec);
    }
    clearForces() { this.totalForce.set(0, 0, 0); this.totalAngAccel.set(0, 0, 0); }
  }

  // btContactConstraint.cpp resolveSingleBilateral (body2 may be null = static)
  function resolveSingleBilateral(body1, pos1, body2, pos2, normal) {
    if (normal.length2() > 1.1) return 0;
    const rel1 = pos1.sub(body1.pos);
    const rel2 = body2 ? pos2.sub(body2.pos) : pos2;
    const vel1 = body1.velocityAt(rel1);
    const vel2 = body2 ? body2.velocityAt(rel2) : ZERO;

    // btJacobianEntry diagonal
    const aJ = body1.rot.tmulVec(rel1.cross(normal));
    let jacDiag = body1.invMass + body1.invInertiaLocal.mulVec(aJ).dot(aJ);
    if (body2) {
      const bJ = body2.rot.tmulVec(rel2.cross(normal.neg()));
      jacDiag += body2.invMass + body2.invInertiaLocal.mulVec(bJ).dot(bJ);
    }
    const relVel = normal.dot(vel1.sub(vel2));
    const contactDamping = 0.2;
    return -contactDamping * relVel / jacDiag;
  }

  // btContactConstraint.cpp resolveSingleCollision against a static object, applyImpulses = false
  function resolveSingleCollision(body1, contactPos, normal, distance, timeStep) {
    const rel1 = contactPos.sub(body1.pos);
    const relVel = normal.dot(body1.velocityAt(rel1));
    const positionalError = SOLVER.erp * -distance / timeStep;
    const velocityError = -relVel;
    const jacDiagABInv = 1 / body1.computeImpulseDenominator(contactPos, normal);
    const normalImpulse = (positionalError + velocityError) * jacDiagABInv;
    return normalImpulse < 0 ? 0 : normalImpulse;
  }

  class SolverBody {
    constructor(body, dt) {
      this.body = body;
      this.dLin = new Vec3(); this.dAng = new Vec3();
      this.push = new Vec3(); this.turn = new Vec3();
      if (body) {
        this.invMass = body.invMass;
        this.invIW = body.invInertiaWorld;
        this.linVel = body.linVel.clone();
        this.angVel = body.angVel.clone();
        this.extF = body.totalForce.mul(body.invMass * dt);
        this.extT = body.totalAngAccel.mul(dt);
        this.pos = body.pos.clone();
        this.rot = body.rot.clone();
      } else {
        this.invMass = 0;
        this.linVel = ZERO; this.angVel = ZERO; this.extF = ZERO; this.extT = ZERO;
      }
    }
    applyImpulse(lin, ang, mag) {
      if (!this.body) return;
      this.dLin.addScaledLocal(lin, mag);
      this.dAng.addScaledLocal(ang, mag);
    }
    applyPushImpulse(lin, ang, mag) {
      if (!this.body) return;
      this.push.addScaledLocal(lin, mag);
      this.turn.addScaledLocal(ang, mag);
    }
    velocityNoDelta(rel) {
      if (!this.body) return ZERO;
      return this.linVel.add(this.extF).add(this.angVel.add(this.extT).cross(rel));
    }
  }

  function resolveRow(row, lowerOnly) {
    const a = row.sa, b = row.sb;
    let delta = row.rhs - row.applied * row.cfm;
    delta -= (row.n1.dot(a.dLin) + row.rp1.dot(a.dAng)) * row.jacInv;
    delta -= (row.n2.dot(b.dLin) + row.rp2.dot(b.dAng)) * row.jacInv;
    const sum = row.applied + delta;
    if (sum < row.lower) {
      delta = row.lower - row.applied;
      row.applied = row.lower;
    } else if (!lowerOnly && sum > row.upper) {
      delta = row.upper - row.applied;
      row.applied = row.upper;
    } else {
      row.applied = sum;
    }
    a.applyImpulse(row.n1.mul(a.invMass), row.angA, delta);
    b.applyImpulse(row.n2.mul(b.invMass), row.angB, delta);
    return delta / row.jacInv;
  }

  function resolveSplitPenetration(row) {
    if (!row.rhsPen) return 0;
    const a = row.sa, b = row.sb;
    let delta = row.rhsPen - row.appliedPush * row.cfm;
    delta -= (row.n1.dot(a.push) + row.rp1.dot(a.turn)) * row.jacInv;
    delta -= (row.n2.dot(b.push) + row.rp2.dot(b.turn)) * row.jacInv;
    const sum = row.appliedPush + delta;
    if (sum < row.lower) {
      delta = row.lower - row.appliedPush;
      row.appliedPush = row.lower;
    } else {
      row.appliedPush = sum;
    }
    a.applyPushImpulse(row.n1.mul(a.invMass), row.angA, delta);
    b.applyPushImpulse(row.n2.mul(b.invMass), row.angB, delta);
    return delta / row.jacInv;
  }

  class Solver {
    solve(contacts, bodies, dt) {
      const map = new Map();
      const staticBody = new SolverBody(null, dt);
      const get = body => {
        if (!body) return staticBody;
        let sb = map.get(body);
        if (!sb) { sb = new SolverBody(body, dt); map.set(body, sb); }
        return sb;
      };
      bodies.forEach(get);

      const rows = [], frictionRows = [];
      const special = new Map();

      const setupContact = (sa, sb, cp, rel1, rel2) => {
        const n = cp.normal;
        const row = { sa, sb, applied: 0, appliedPush: 0, cfm: 0, lower: 0, upper: 1e10, special: !!cp.special };
        const torqueAxis0 = rel1.cross(n);
        const torqueAxis1 = rel2.cross(n);
        row.angA = sa.body ? sa.invIW.mulVec(torqueAxis0) : ZERO;
        row.angB = sb.body ? sb.invIW.mulVec(torqueAxis1.neg()) : ZERO;
        const denom0 = sa.body ? sa.invMass + n.dot(row.angA.cross(rel1)) : 0;
        const denom1 = sb.body ? sb.invMass + n.dot(row.angB.neg().cross(rel2)) : 0;
        row.jacInv = 1 / (denom0 + denom1);
        row.n1 = sa.body ? n : ZERO;
        row.rp1 = sa.body ? torqueAxis0 : ZERO;
        row.n2 = sb.body ? n.neg() : ZERO;
        row.rp2 = sb.body ? torqueAxis1.neg() : ZERO;

        const penetration = cp.distance;
        const vel1 = sa.body ? sa.body.velocityAt(rel1) : ZERO;
        const vel2 = sb.body ? sb.body.velocityAt(rel2) : ZERO;
        const relVel = n.dot(vel1.sub(vel2));
        let restitution = Math.abs(relVel) < SOLVER.restitutionVelocityThreshold ? 0 : cp.restitution * -relVel;
        if (restitution <= 0) restitution = 0;

        row.applied = (cp.warmImpulse || 0) * SOLVER.warmstartingFactor;
        if (row.applied) {
          sa.applyImpulse(row.n1.mul(sa.invMass), row.angA, row.applied);
          sb.applyImpulse(row.n2.neg().mul(sb.invMass), row.angB.neg(), -row.applied);
        }

        const vel1Dotn = row.n1.dot(sa.linVel.add(sa.extF)) + row.rp1.dot(sa.angVel.add(sa.extT));
        const vel2Dotn = row.n2.dot(sb.linVel.add(sb.extF)) + row.rp2.dot(sb.angVel.add(sb.extT));
        const positionalError = penetration > 0 ? 0 : -penetration * SOLVER.erp2 / dt;
        row.rhs = (restitution - (vel1Dotn + vel2Dotn)) * row.jacInv;
        row.rhsPen = positionalError * row.jacInv;
        return row;
      };

      const addFriction = (sa, sb, dir, friction, rel1, rel2, frictionIndex) => {
        const row = { sa, sb, applied: 0, appliedPush: 0, cfm: 0, friction, frictionIndex };
        row.n1 = sa.body ? dir : ZERO;
        row.rp1 = sa.body ? rel1.cross(dir) : ZERO;
        row.angA = sa.body ? sa.invIW.mulVec(row.rp1) : ZERO;
        row.n2 = sb.body ? dir.neg() : ZERO;
        row.rp2 = sb.body ? rel2.cross(row.n2) : ZERO;
        row.angB = sb.body ? sb.invIW.mulVec(row.rp2) : ZERO;
        const denom0 = sa.body ? sa.invMass + dir.dot(row.angA.cross(rel1)) : 0;
        const denom1 = sb.body ? sb.invMass + dir.dot(row.angB.neg().cross(rel2)) : 0;
        row.jacInv = 1 / (denom0 + denom1);
        const relVel = row.n1.dot(sa.linVel.add(sa.extF)) + row.rp1.dot(sa.angVel) +
                       row.n2.dot(sb.linVel.add(sb.extF)) + row.rp2.dot(sb.angVel);
        row.rhs = -relVel * row.jacInv;
        row.lower = -friction;
        row.upper = friction;
        frictionRows.push(row);
      };

      const convertInner = (sa, sb, cp, rel1, rel2, frictionIndex) => {
        const vel = sa.velocityNoDelta(rel1).sub(sb.velocityNoDelta(rel2));
        const relVel = cp.normal.dot(vel);
        const lateral = vel.sub(cp.normal.mul(relVel));
        const latRelVel = lateral.length2();
        if (latRelVel > SIMD_EPSILON) {
          addFriction(sa, sb, lateral.mul(1 / Math.sqrt(latRelVel)), cp.friction, rel1, rel2, frictionIndex);
        } else {
          addFriction(sa, sb, planeSpace(cp.normal)[0], cp.friction, rel1, rel2, frictionIndex);
        }
      };

      for (const cp of contacts) {
        const sa = get(cp.a), sb = get(cp.b);
        const rel1 = cp.pointA.sub(cp.a.pos);
        const rel2 = cp.b ? cp.pointB.sub(cp.b.pos) : cp.pointB;
        const frictionIndex = rows.length;
        const row = setupContact(sa, sb, cp, rel1, rel2);
        rows.push(row);
        cp.row = row;

        if (cp.special) {
          [[cp.a, rel1], [cp.b, rel2]].forEach(([body, rel]) => {
            if (!body) return;
            let info = special.get(body);
            if (!info) { info = { num: 0, totalNormal: new Vec3(), totalDist: 0 }; special.set(body, info); }
            info.num++;
            info.friction = cp.friction;
            info.restitution = cp.restitution;
            info.totalNormal.addLocal(cp.normal);
            info.totalDist += rel.length();
          });
        }
        convertInner(sa, sb, cp, rel1, rel2, frictionIndex);
      }

      // ROCKETSIM CHANGE: one averaged constraint per body for its special contacts
      special.forEach((info, body) => {
        const tmp = {
          normal: info.totalNormal.mul(1 / info.num),
          distance: info.totalDist / info.num,
          friction: info.friction,
          restitution: info.restitution
        };
        const sa = get(body);
        const rel1 = tmp.normal.mul(-tmp.distance);
        const frictionIndex = rows.length;
        rows.push(setupContact(sa, staticBody, tmp, rel1, ZERO));
        convertInner(sa, staticBody, tmp, rel1, ZERO, frictionIndex);
      });

      // Split impulse (position recovery) iterations
      for (let it = 0; it < SOLVER.numIterations; it++) {
        let residual = 0;
        for (const row of rows) {
          const r = resolveSplitPenetration(row);
          residual = Math.max(residual, r * r);
        }
        if (residual <= 0 || it >= SOLVER.numIterations - 1) break;
      }

      // Velocity iterations: contacts (skipping special ones), then friction
      for (let it = 0; it < SOLVER.numIterations; it++) {
        for (const row of rows) {
          if (!row.special) resolveRow(row, true);
        }
        for (const fr of frictionRows) {
          const totalImpulse = rows[fr.frictionIndex].applied;
          if (totalImpulse > 0) {
            fr.lower = -(fr.friction * totalImpulse);
            fr.upper = fr.friction * totalImpulse;
            resolveRow(fr, false);
          }
        }
      }

      // writebackBodies
      map.forEach(sb => {
        const body = sb.body;
        const linVel = sb.linVel.add(sb.dLin);
        const angVel = sb.angVel.add(sb.dAng);
        if (!sb.push.isZero() || !sb.turn.isZero()) {
          const t = integrateTransform(sb.pos, sb.rot, sb.push, sb.turn.mul(SOLVER.splitImpulseTurnErp), dt);
          body.pos = t.pos;
          body.rot = t.rot;
        }
        body.linVel = linVel.add(sb.extF);
        body.angVel = angVel.add(sb.extT);
      });

      for (const cp of contacts) cp.appliedImpulse = cp.row.applied;
    }
  }

  return { RigidBody, Solver, SolverBody, resolveSingleBilateral, resolveSingleCollision, SOLVER };
})();
