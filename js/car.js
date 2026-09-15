// Car simulation: port of RocketSim's Car.cpp and btVehicleRL.cpp (MIT, ZealanL).
// Units are Bullet units (BT) like RocketSim; *_UU values are Unreal units.
window.Game = window.Game || {};

Game.CarSim = (function () {
  const RL = Game.RL, U = RL.UU_TO_BT, BT = RL.BT_TO_UU, V = RL.BTVehicle;
  const { Vec3, Mat3, clamp, sgn, SIMD_EPSILON } = Game.Math;
  const { RigidBody, resolveSingleBilateral, resolveSingleCollision } = Game.Physics;

  function defaultControls() {
    return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
  }

  function defaultState() {
    return {
      isOnGround: true,
      wheelsWithContact: [false, false, false, false],
      hasJumped: false,
      hasDoubleJumped: false,
      hasFlipped: false,
      flipRelTorque: new Vec3(),
      jumpTime: 0,
      flipTime: 0,
      isFlipping: false,
      isJumping: false,
      airTime: 0,
      airTimeSinceJump: 0,
      boost: RL.BOOST_MAX, // infinite boost: never drained
      timeSinceBoosted: 0,
      isBoosting: false,
      boostingTime: 0,
      isSupersonic: false,
      supersonicTime: 0,
      handbrakeVal: 0,
      isAutoFlipping: false,
      autoFlipTimer: 0,
      autoFlipTorqueScale: 0,
      worldContact: { hasContact: false, contactNormal: new Vec3() },
      lastControls: defaultControls()
    };
  }

  class CarSim {
    constructor(config) {
      this.config = config;
      const size = Vec3.from(config.hitboxSize).mul(U);
      this.hitboxHalf = size.mul(0.5);
      this.hitboxOffset = Vec3.from(config.hitboxPosOffset).mul(U);

      const m = RL.CAR_MASS_BT;
      const inertia = new Vec3(
        m / 12 * (size.y * size.y + size.z * size.z),
        m / 12 * (size.x * size.x + size.z * size.z),
        m / 12 * (size.x * size.x + size.y * size.y)
      );
      this.body = new RigidBody({ mass: m, inertia, friction: RL.CAR_COLLISION_FRICTION, restitution: RL.CAR_COLLISION_RESTITUTION });

      this.wheels = [];
      for (let i = 0; i < 4; i++) {
        const front = i < 2, left = i % 2 === 1;
        const wc = front ? config.frontWheels : config.backWheels;
        const conn = Vec3.from(wc.connectionPointOffset);
        if (left) conn.y *= -1;
        this.wheels.push({
          front,
          radius: wc.wheelRadius * U,
          connectionCS: conn.mul(U),
          restLength: (wc.suspensionRestLength - V.MAX_SUSPENSION_TRAVEL) * U,
          maxTravel: V.MAX_SUSPENSION_TRAVEL * U,
          forceScale: front ? V.SUSPENSION_FORCE_SCALE_FRONT : V.SUSPENSION_FORCE_SCALE_BACK
        });
      }

      this.controls = defaultControls();
      this.ballHitTickApplied = -1000;
      this.events = [];
      this.boostUsedPerSecond = 0; // 0 = unlimited boost, 100/3 = standard (MutatorConfig::boostUsedPerSecond)
      this.setState(new Vec3(0, 0, RL.CAR_SPAWN_REST_Z * U), Math.PI / 2);
    }

    setState(pos, yaw) {
      const b = this.body;
      b.pos = pos.clone();
      b.rot = Mat3.fromAngle(yaw, 0, 0);
      b.linVel = new Vec3();
      b.angVel = new Vec3();
      b.velocityImpulseCache = new Vec3();
      b.clearForces();
      b.updateInertiaTensor();
      this.state = defaultState();
      for (const w of this.wheels) {
        Object.assign(w, {
          steerAngle: 0, engineForce: 0, brake: 0, latFriction: 0, longFriction: 0,
          inContact: false, inContactWithWorld: false, hasGround: false, groundBody: null,
          suspensionLength: w.restLength, suspRelVel: 0, clippedInvContactDot: 1, extraPushback: 0,
          suspensionForce: 0, impulse: new Vec3(), contactNormalWS: new Vec3(0, 0, 1)
        });
        this.updateWheelTransform(w);
        w.contactPointWS = w.hardPointWS.clone();
      }
    }

    forward() { return this.body.rot.col(0); }
    right() { return this.body.rot.col(1); }
    up() { return this.body.rot.col(2); }

    // ---------------- btVehicleRL ----------------

    updateWheelTransformsWS(w) {
      const b = this.body;
      w.inContact = false;
      w.inContactWithWorld = false;
      w.hardPointWS = b.pos.add(b.rot.mulVec(w.connectionCS));
      w.wheelDirWS = b.rot.mulVec(new Vec3(0, 0, -1));
      w.axleWS = b.rot.mulVec(new Vec3(0, -1, 0));
    }

    updateWheelTransform(w) {
      this.updateWheelTransformsWS(w);
      const up = w.wheelDirWS.neg();
      const v = w.axleWS.neg(); // basis column for the right axis before steering
      const c = Math.cos(w.steerAngle), s = Math.sin(w.steerAngle);
      w.rightWS = v.mul(c).add(up.cross(v).mul(s)).add(up.mul(up.dot(v) * (1 - c)));
    }

    rayCast(w, world, dt) {
      this.updateWheelTransformsWS(w);
      const b = this.body;
      const travel = w.maxTravel;
      const realRayLength = w.restLength + travel + w.radius - V.SUSPENSION_SUBTRACTION;

      w.contactPointWS = w.hardPointWS.add(w.wheelDirWS.mul(realRayLength));
      w.hasGround = false;
      w.groundBody = null;

      const hit = world.rayCast(w.hardPointWS, w.wheelDirWS, realRayLength, this);
      if (hit) {
        w.contactPointWS = hit.point;
        w.contactNormalWS = hit.normal;
        w.inContact = true;
        w.inContactWithWorld = hit.body === null;
        w.hasGround = true;
        w.groundBody = hit.body;

        const up = b.rot.col(2);
        const wheelTraceLen = w.hardPointWS.sub(w.contactPointWS).dot(up);
        w.suspensionLength = clamp(wheelTraceLen - w.radius, w.restLength - travel, w.restLength + travel);

        const denominator = w.contactNormalWS.dot(up);
        const relpos = w.contactPointWS.sub(b.pos);
        const projVel = w.contactNormalWS.dot(b.velocityAt(relpos));
        if (denominator > 0.1) {
          w.suspRelVel = projVel / denominator;
          w.clippedInvContactDot = 1 / denominator;
        } else {
          w.suspRelVel = 0;
          w.clippedInvContactDot = 10;
        }

        if (w.inContactWithWorld) {
          const pushbackThresh = (w.restLength + w.radius) - V.SUSPENSION_SUBTRACTION;
          if (wheelTraceLen < pushbackThresh) {
            const result = resolveSingleCollision(b, hit.point, hit.normal, wheelTraceLen - pushbackThresh, dt);
            w.extraPushback = result / this.wheels.length;
          }
        }
      } else {
        w.suspensionLength = w.restLength + travel;
        w.suspRelVel = 0;
        w.contactNormalWS = w.wheelDirWS.neg();
        w.clippedInvContactDot = 1;
        w.extraPushback = 0;
      }
    }

    calcFrictionImpulses() {
      const b = this.body;
      const frictionScale = b.mass / 3;
      for (const w of this.wheels) {
        if (!w.hasGround) { w.impulse = new Vec3(); continue; }

        const n = w.contactNormalWS;
        let axleDir = w.rightWS;
        axleDir = axleDir.sub(n.mul(axleDir.dot(n))).safeNormalized();
        const forwardDir = n.cross(axleDir).safeNormalized();

        const sideImpulse = resolveSingleBilateral(b, w.contactPointWS, w.groundBody, w.contactPointWS, axleDir);

        let rollingFriction;
        if (w.engineForce === 0) {
          if (w.brake) {
            const carRel = w.contactPointWS.sub(b.pos);
            const v1 = b.velocityAt(carRel);
            const v2 = w.groundBody ? w.groundBody.velocityAt(carRel) : new Vec3();
            const relVel = v1.sub(v2).dot(forwardDir);
            const ROLLING_FRICTION_SCALE_MAGIC = 113.73963;
            rollingFriction = clamp(-relVel * ROLLING_FRICTION_SCALE_MAGIC, -w.brake, w.brake);
          } else {
            rollingFriction = 0;
          }
        } else {
          rollingFriction = -w.engineForce / frictionScale;
        }

        const total = forwardDir.mul(rollingFriction * w.longFriction).add(axleDir.mul(sideImpulse * w.latFriction));
        w.impulse = total.mul(frictionScale);
      }
    }

    updateSuspension(dt) {
      const b = this.body;
      for (const w of this.wheels) {
        if (w.inContact) {
          const force = (w.restLength - w.suspensionLength) * V.SUSPENSION_STIFFNESS * w.clippedInvContactDot;
          const dampingVelScale = w.suspRelVel < 0 ? V.WHEELS_DAMPING_COMPRESSION : V.WHEELS_DAMPING_RELAXATION;
          let f = (force - dampingVelScale * w.suspRelVel) * w.forceScale;
          if (f < 0) f = 0;
          w.suspensionForce = f;
        } else {
          w.suspensionForce = 0;
        }
      }
      for (const w of this.wheels) {
        if (w.suspensionForce !== 0) {
          const offset = w.contactPointWS.sub(b.pos);
          const baseForceScale = w.suspensionForce * dt + w.extraPushback;
          b.applyImpulse(w.contactNormalWS.mul(baseForceScale), offset);
        }
      }
    }

    applyFrictionImpulses(dt) {
      const b = this.body;
      const up = b.rot.col(2);
      for (const w of this.wheels) {
        if (w.impulse.isZero()) continue;
        const offset = w.contactPointWS.sub(b.pos);
        const relPos = offset.sub(up.mul(up.dot(offset)));
        b.applyImpulse(w.impulse.mul(dt), relPos);
      }
    }

    upwardsDirFromWheelContacts() {
      const sum = new Vec3();
      for (const w of this.wheels) if (w.inContact) sum.addLocal(w.contactNormalWS);
      return sum.isZero() ? this.up() : sum.safeNormalized();
    }

    // ---------------- Car.cpp ----------------

    preTick(dt, world) {
      const c = this.controls, s = this.state;
      c.throttle = clamp(c.throttle, -1, 1);
      c.steer = clamp(c.steer, -1, 1);
      c.pitch = clamp(c.pitch, -1, 1);
      c.yaw = clamp(c.yaw, -1, 1);
      c.roll = clamp(c.roll, -1, 1);

      // updateVehicleFirst
      for (const w of this.wheels) this.updateWheelTransform(w);
      for (const w of this.wheels) this.rayCast(w, world, dt);
      this.calcFrictionImpulses();

      const jumpPressed = c.jump && !s.lastControls.jump;

      let numWheelsInContact = 0;
      this.wheels.forEach((w, i) => { s.wheelsWithContact[i] = w.inContact; numWheelsInContact += w.inContact ? 1 : 0; });
      s.isOnGround = numWheelsInContact >= 3;

      const forwardSpeedUU = this.body.linVel.dot(this.forward()) * BT;
      this.updateWheels(dt, numWheelsInContact, forwardSpeedUU);

      if (numWheelsInContact < 3) this.updateAirTorque(numWheelsInContact === 0);
      else s.isFlipping = false;

      this.updateJump(dt, jumpPressed);
      this.updateAutoFlip(dt, jumpPressed);
      this.updateDoubleJumpOrFlip(dt, jumpPressed, forwardSpeedUU);

      if (c.throttle && ((numWheelsInContact > 0 && numWheelsInContact < 4) || s.worldContact.hasContact)) {
        this.updateAutoRoll(numWheelsInContact);
      }
      s.worldContact.hasContact = false;

      // updateVehicleSecond
      this.updateSuspension(dt);
      this.applyFrictionImpulses(dt);

      this.updateBoost(dt);
    }

    updateWheels(dt, numWheelsInContact, forwardSpeedUU) {
      const c = this.controls, s = this.state, b = this.body;
      const absForwardSpeedUU = Math.abs(forwardSpeedUU);

      let wheelsHaveWorldContact = false;
      for (const w of this.wheels) wheelsHaveWorldContact = wheelsHaveWorldContact || w.inContactWithWorld;

      s.handbrakeVal += (c.handbrake ? RL.POWERSLIDE_RISE_RATE : -RL.POWERSLIDE_FALL_RATE) * dt;
      s.handbrakeVal = clamp(s.handbrakeVal, 0, 1);

      let realThrottle = c.throttle;
      let realBrake = 0;
      if (c.boost && s.boost > 0) realThrottle = 1;

      { // Throttle / brake
        let driveSpeedScale = RL.DRIVE_SPEED_TORQUE_FACTOR_CURVE(absForwardSpeedUU);
        let engineThrottle = realThrottle;

        if (!c.handbrake) {
          if (Math.abs(realThrottle) >= RL.THROTTLE_DEADZONE) {
            if (absForwardSpeedUU > RL.STOPPING_FORWARD_VEL && sgn(realThrottle) !== sgn(forwardSpeedUU)) {
              realBrake = 1;
              if (absForwardSpeedUU > RL.BRAKING_NO_THROTTLE_SPEED_THRESH) engineThrottle = 0;
            }
          } else {
            engineThrottle = 0;
            realBrake = absForwardSpeedUU < RL.STOPPING_FORWARD_VEL ? 1 : RL.COASTING_BRAKE_FACTOR;
          }
        }

        if (numWheelsInContact < 3) driveSpeedScale /= 4;

        const driveEngineForce = engineThrottle * (RL.THROTTLE_TORQUE_AMOUNT * U) * driveSpeedScale;
        const driveBrakeForce = realBrake * (RL.BRAKE_TORQUE_AMOUNT * U);
        for (const w of this.wheels) {
          w.engineForce = driveEngineForce;
          w.brake = driveBrakeForce;
        }
      }

      { // Steering
        let steerAngle = RL.STEER_ANGLE_FROM_SPEED_CURVE(absForwardSpeedUU);
        if (s.handbrakeVal) {
          steerAngle += (RL.POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE(absForwardSpeedUU) - steerAngle) * s.handbrakeVal;
        }
        steerAngle *= c.steer;
        this.wheels[0].steerAngle = steerAngle;
        this.wheels[1].steerAngle = steerAngle;
      }

      // Tire friction
      for (const w of this.wheels) {
        if (!w.hasGround) continue;
        const latDir = w.rightWS;
        const longDir = latDir.cross(w.contactNormalWS);
        let frictionCurveInput = 0;

        const wheelDelta = w.hardPointWS.sub(b.pos);
        const crossVec = b.angVel.cross(wheelDelta).add(b.linVel).mul(BT);
        const baseFriction = Math.abs(crossVec.dot(latDir));
        if (baseFriction > 5) frictionCurveInput = baseFriction / (Math.abs(crossVec.dot(longDir)) + baseFriction);

        let latFriction = RL.LAT_FRICTION_CURVE(frictionCurveInput);
        let longFriction = RL.LONG_FRICTION_CURVE(frictionCurveInput);

        if (s.handbrakeVal) {
          const hb = s.handbrakeVal;
          latFriction *= (RL.HANDBRAKE_LAT_FRICTION_FACTOR_CURVE(frictionCurveInput) - 1) * hb + 1;
          longFriction *= (RL.HANDBRAKE_LONG_FRICTION_FACTOR_CURVE(frictionCurveInput) - 1) * hb + 1;
        } else {
          longFriction = 1;
        }

        if (realThrottle === 0) {
          const nonStickyScale = RL.NON_STICKY_FRICTION_FACTOR_CURVE(w.contactNormalWS.z);
          latFriction *= nonStickyScale;
          longFriction *= nonStickyScale;
        }

        w.latFriction = latFriction;
        w.longFriction = longFriction;
      }

      // Sticky forces
      if (wheelsHaveWorldContact) {
        const upwardsDir = this.upwardsDirFromWheelContacts();
        const fullStick = realThrottle !== 0 || absForwardSpeedUU > RL.STOPPING_FORWARD_VEL;
        let stickyForceScale = 0.5;
        if (fullStick) stickyForceScale += 1 - Math.abs(upwardsDir.z);
        b.applyCentralForce(upwardsDir.mul(stickyForceScale * (RL.GRAVITY_Z * U) * RL.CAR_MASS_BT));
      }
    }

    updateBoost(dt) {
      const c = this.controls, s = this.state;
      if (s.boost > 0) {
        if (s.isBoosting) s.isBoosting = c.boost || s.boostingTime < RL.BOOST_MIN_TIME;
        else if (c.boost) s.isBoosting = true;
      } else {
        s.isBoosting = false;
      }

      s.boostingTime = s.isBoosting ? s.boostingTime + dt : 0;

      if (s.isBoosting) {
        s.boost = Math.max(s.boost - this.boostUsedPerSecond * dt, 0);
        const accel = s.isOnGround ? RL.BOOST_ACCEL_GROUND : RL.BOOST_ACCEL_AIR;
        this.body.applyCentralForce(this.forward().mul(accel * U * RL.CAR_MASS_BT));
        s.timeSinceBoosted = 0;
      } else {
        s.timeSinceBoosted += dt;
      }
    }

    updateJump(dt, jumpPressed) {
      const c = this.controls, s = this.state, b = this.body;
      if (s.isOnGround && !s.isJumping) {
        if (s.hasJumped && s.jumpTime < RL.JUMP_MIN_TIME + RL.JUMP_RESET_TIME_PAD) {
          // might still be leaving the ground
        } else {
          s.hasJumped = false;
          s.jumpTime = 0;
        }
      }

      if (s.isJumping) {
        s.isJumping = s.jumpTime < RL.JUMP_MIN_TIME || (c.jump && s.jumpTime < RL.JUMP_MAX_TIME);
      } else if (s.isOnGround && jumpPressed) {
        s.isJumping = true;
        s.jumpTime = 0;
        b.applyCentralImpulse(this.up().mul(RL.JUMP_IMMEDIATE_FORCE * U * RL.CAR_MASS_BT));
        this.events.push({ type: 'jump' });
      }

      if (s.isJumping) {
        s.hasJumped = true;
        let totalJumpForce = this.up().mul(RL.JUMP_ACCEL);
        if (s.jumpTime < RL.JUMP_MIN_TIME) totalJumpForce = totalJumpForce.mul(RL.JUMP_PRE_MIN_ACCEL_SCALE);
        b.applyCentralForce(totalJumpForce.mul(U * RL.CAR_MASS_BT));
      }

      if (s.isJumping || s.hasJumped) s.jumpTime += dt;
    }

    updateAirTorque(updateAirControl) {
      const c = this.controls, s = this.state, b = this.body;
      const dirPitchRight = this.right().neg();
      const dirYawUp = this.up();
      const dirRollForward = this.forward().neg();

      let doAirControl = false;
      if (s.isFlipping) s.isFlipping = s.hasFlipped && s.flipTime < RL.FLIP_TORQUE_TIME;

      if (s.isFlipping) {
        const relDodgeTorque = s.flipRelTorque.clone();
        if (!s.flipRelTorque.isZero()) {
          // Flip cancel
          let pitchScale = 1;
          if (relDodgeTorque.y !== 0 && c.pitch !== 0 && sgn(relDodgeTorque.y) === sgn(c.pitch)) {
            pitchScale = 1 - Math.min(Math.abs(c.pitch), 1);
            doAirControl = true;
          }
          relDodgeTorque.y *= pitchScale;
          const dodgeTorque = new Vec3(relDodgeTorque.x * RL.FLIP_TORQUE_X, relDodgeTorque.y * RL.FLIP_TORQUE_Y, 0);
          b.applyAngularAccel(b.rot.mulVec(dodgeTorque));
        } else {
          doAirControl = true; // stall
        }
      } else {
        doAirControl = true;
      }

      doAirControl = doAirControl && !s.isAutoFlipping && updateAirControl;
      if (doAirControl) {
        const T = RL.CAR_AIR_CONTROL_TORQUE, D = RL.CAR_AIR_CONTROL_DAMPING;
        let pitchTorqueScale = 1;
        let torque = new Vec3();
        if (c.pitch || c.yaw || c.roll) {
          if (s.isFlipping) pitchTorqueScale = 0;
          else if (s.hasFlipped && s.flipTime < RL.FLIP_TORQUE_TIME + RL.FLIP_PITCHLOCK_EXTRA_TIME) pitchTorqueScale = 0;

          torque = dirPitchRight.mul(c.pitch * pitchTorqueScale * T.pitch)
            .add(dirYawUp.mul(c.yaw * T.yaw))
            .add(dirRollForward.mul(c.roll * T.roll));
        }

        const angVel = b.angVel;
        const dampPitch = dirPitchRight.dot(angVel) * D.pitch * (1 - Math.abs(c.pitch * pitchTorqueScale));
        const dampYaw = dirYawUp.dot(angVel) * D.yaw * (1 - Math.abs(c.yaw));
        const dampRoll = dirRollForward.dot(angVel) * D.roll;

        const damping = dirYawUp.mul(dampYaw).add(dirPitchRight.mul(dampPitch)).add(dirRollForward.mul(dampRoll));
        b.applyAngularAccel(torque.sub(damping).mul(RL.CAR_TORQUE_SCALE));
      }

      if (c.throttle !== 0) {
        b.applyCentralForce(this.forward().mul(c.throttle * RL.THROTTLE_AIR_ACCEL * U * RL.CAR_MASS_BT));
      }
    }

    updateDoubleJumpOrFlip(dt, jumpPressed, forwardSpeedUU) {
      const c = this.controls, s = this.state, b = this.body;
      const tickTimeScale = dt / (1 / 120);

      if (s.isOnGround) {
        s.hasDoubleJumped = false;
        s.hasFlipped = false;
        s.airTime = 0;
        s.airTimeSinceJump = 0;
        s.flipTime = 0;
      } else {
        s.airTime += dt;
        s.airTimeSinceJump = (s.hasJumped && !s.isJumping) ? s.airTimeSinceJump + dt : 0;

        if (jumpPressed && s.airTimeSinceJump < RL.DOUBLEJUMP_MAX_DELAY) {
          const inputMagnitude = Math.abs(c.yaw) + Math.abs(c.pitch) + Math.abs(c.roll);
          const isFlipInput = inputMagnitude >= this.config.dodgeDeadzone;
          let canUse = !s.hasDoubleJumped && !s.hasFlipped;
          if (s.isAutoFlipping) canUse = false;

          if (canUse) {
            if (isFlipInput) {
              s.flipTime = 0;
              s.hasFlipped = true;
              s.isFlipping = true;
              this.events.push({ type: 'flip' });

              const forwardSpeedRatio = Math.abs(forwardSpeedUU) / RL.CAR_MAX_SPEED;
              let dodgeDir = new Vec3(-c.pitch, c.yaw + c.roll, 0);
              if (Math.abs(c.yaw + c.roll) < 0.1 && Math.abs(c.pitch) < 0.1) dodgeDir = new Vec3();
              else dodgeDir = dodgeDir.safeNormalized();

              s.flipRelTorque = new Vec3(-dodgeDir.y / tickTimeScale, dodgeDir.x / tickTimeScale, 0);

              if (Math.abs(dodgeDir.x) < 0.1) dodgeDir.x = 0;
              if (Math.abs(dodgeDir.y) < 0.1) dodgeDir.y = 0;

              if (dodgeDir.length2() >= SIMD_EPSILON * SIMD_EPSILON) {
                const shouldDodgeBackwards = Math.abs(forwardSpeedUU) < 100
                  ? dodgeDir.x < 0
                  : (dodgeDir.x >= 0) !== (forwardSpeedUU >= 0);

                const initialDodgeVel = dodgeDir.mul(RL.FLIP_INITIAL_VEL_SCALE);
                const maxSpeedScaleX = shouldDodgeBackwards ? RL.FLIP_BACKWARD_IMPULSE_MAX_SPEED_SCALE : RL.FLIP_FORWARD_IMPULSE_MAX_SPEED_SCALE;
                initialDodgeVel.x *= (maxSpeedScaleX - 1) * forwardSpeedRatio + 1;
                initialDodgeVel.y *= (RL.FLIP_SIDE_IMPULSE_MAX_SPEED_SCALE - 1) * forwardSpeedRatio + 1;
                if (shouldDodgeBackwards) initialDodgeVel.x *= RL.FLIP_BACKWARD_IMPULSE_SCALE_X;

                const f = this.forward();
                const forwardDir2D = new Vec3(f.x, f.y, 0).normalized();
                const rightDir2D = new Vec3(-forwardDir2D.y, forwardDir2D.x, 0);
                const finalDeltaVel = forwardDir2D.mul(initialDodgeVel.x).add(rightDir2D.mul(initialDodgeVel.y));
                b.applyCentralImpulse(finalDeltaVel.mul(U * RL.CAR_MASS_BT));
              }
            } else {
              b.applyCentralImpulse(this.up().mul(RL.JUMP_IMMEDIATE_FORCE * U * RL.CAR_MASS_BT));
              s.hasDoubleJumped = true;
              this.events.push({ type: 'jump', second: true });
            }
          }
        }
      }

      if (s.isFlipping) {
        s.flipTime += dt;
        if (s.flipTime <= RL.FLIP_TORQUE_TIME &&
            s.flipTime >= RL.FLIP_Z_DAMP_START && (b.linVel.z < 0 || s.flipTime < RL.FLIP_Z_DAMP_END)) {
          b.linVel.z *= Math.pow(1 - RL.FLIP_Z_DAMP_120, tickTimeScale);
        }
      } else if (s.hasFlipped) {
        s.flipTime += dt;
      }
    }

    updateAutoFlip(dt, jumpPressed) {
      const s = this.state, b = this.body;
      if (jumpPressed && s.worldContact.hasContact && s.worldContact.contactNormal.z > RL.CAR_AUTOFLIP_NORMZ_THRESH) {
        const roll = -Math.atan2(b.rot.e[7], b.rot.e[8]); // Angle::FromRotMat
        const absRoll = Math.abs(roll);
        if (absRoll > RL.CAR_AUTOFLIP_ROLL_THRESH) {
          s.autoFlipTimer = RL.CAR_AUTOFLIP_TIME * (absRoll / Math.PI);
          s.autoFlipTorqueScale = roll > 0 ? 1 : -1;
          s.isAutoFlipping = true;
          b.applyCentralImpulse(this.up().neg().mul(RL.CAR_AUTOFLIP_IMPULSE * U * RL.CAR_MASS_BT));
        }
      }

      if (s.isAutoFlipping) {
        if (s.autoFlipTimer <= 0) {
          s.isAutoFlipping = false;
          s.autoFlipTimer = 0;
        } else {
          b.angVel.addLocal(this.forward().mul(RL.CAR_AUTOFLIP_TORQUE * s.autoFlipTorqueScale * dt));
          s.autoFlipTimer -= dt;
        }
      }
    }

    updateAutoRoll(numWheelsInContact) {
      const s = this.state, b = this.body;
      const groundUpDir = numWheelsInContact > 0 ? this.upwardsDirFromWheelContacts() : s.worldContact.contactNormal;
      const groundDownDir = groundUpDir.neg();
      const forwardDir = this.forward(), rightDir = this.right();

      const crossRightDir = groundUpDir.cross(forwardDir);
      const crossForwardDir = groundDownDir.cross(crossRightDir);

      const rightTorqueFactor = 1 - clamp(rightDir.dot(crossRightDir), 0, 1);
      const forwardTorqueFactor = 1 - clamp(forwardDir.dot(crossForwardDir), 0, 1);

      const torqueDirRight = forwardDir.mul(rightDir.dot(groundUpDir) >= 0 ? -1 : 1);
      const torqueDirForward = rightDir.mul(forwardDir.dot(groundUpDir) >= 0 ? 1 : -1);

      b.applyCentralForce(groundDownDir.mul(RL.CAR_AUTOROLL_FORCE * U * RL.CAR_MASS_BT));
      b.applyAngularAccel(torqueDirForward.mul(forwardTorqueFactor).add(torqueDirRight.mul(rightTorqueFactor)).mul(RL.CAR_AUTOROLL_TORQUE));
    }

    postTick(dt) {
      const s = this.state;
      const speedSquared = this.body.linVel.mul(BT).length2();
      if (s.isSupersonic && s.supersonicTime < RL.SUPERSONIC_MAINTAIN_MAX_TIME) {
        s.isSupersonic = speedSquared >= RL.SUPERSONIC_MAINTAIN_MIN_SPEED * RL.SUPERSONIC_MAINTAIN_MIN_SPEED;
      } else {
        s.isSupersonic = speedSquared >= RL.SUPERSONIC_START_SPEED * RL.SUPERSONIC_START_SPEED;
      }
      s.supersonicTime = s.isSupersonic ? s.supersonicTime + dt : 0;
      s.lastControls = Object.assign({}, this.controls);
    }

    finishTick() {
      const b = this.body;
      if (!b.velocityImpulseCache.isZero()) {
        b.linVel.addLocal(b.velocityImpulseCache);
        b.velocityImpulseCache = new Vec3();
      }
      const maxSpeed = RL.CAR_MAX_SPEED * U;
      if (b.linVel.length2() > maxSpeed * maxSpeed) b.linVel = b.linVel.normalized().mul(maxSpeed);
      if (b.angVel.length2() > RL.CAR_MAX_ANG_SPEED * RL.CAR_MAX_ANG_SPEED) b.angVel = b.angVel.normalized().mul(RL.CAR_MAX_ANG_SPEED);
    }
  }

  return CarSim;
})();
