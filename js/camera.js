// Rocket League camera, built on the architecture of RL's own camera classes (CameraState_Car_TA,
// CameraState_BallCam_TA, Camera_TA, CameraStateBlender_X in the reverse-engineered SDK). The camera never
// copies the car transform; every frame runs this pipeline:
//
//   car state (position, facing, velocity, grounded, surface normal, speed, supersonic)
//     -> smoothed ground normal, ground rotation (floor / wall rates), air rotation (car facing blended
//        toward velocity), AirGroundBlend between them
//     -> focus (FocusInterp), focus offset (FocusOffsetInterp), speed/stiffness distance (DistanceInterp)
//     -> user Height and Angle (ScalePitch), reduced roll and chassis pitch (UpdateRotationModifiers)
//     -> ball cam on top of that base POV (CurrRotToBall at RotationRate, PitchScale, PitchFocusZFactor,
//        PitchExtentMin/Max), cam switches blended by Transition Speed
//     -> swivel (speed-dependent extents, SwivelDieRate), speed and supersonic FOV, proximity distance,
//        ClipToField, camera shake
//
// All smoothing is exponential in DeltaTime (bFramerateIndependentInterp). The SDK exposes names and
// structure but not function bodies or default values: CFG marks each number MEASURED (published community
// measurements) or ESTIMATE (to be replaced by measurements of Rocket League recordings).
// The FOV setting is horizontal at 16:9 like RL (Hor+ on wider screens). three.js coordinates (Y up), uu.
window.Game = window.Game || {};

Game.ChaseCamera = (function () {
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const DEG = Math.PI / 180;
  const CAR_MAX_SPEED = 2300;
  const clamp = THREE.MathUtils.clamp;
  const lerp = THREE.MathUtils.lerp;

  const CFG = {
    // ---- CameraState_Car_TA
    InterpToAirRate: 3,                   // ESTIMATE AirGroundBlend rate leaving the ground (1/s)
    InterpToGroundRate: 8,                // ESTIMATE AirGroundBlend rate returning to the ground
    FocusInterpRate: 20,                  // ESTIMATE FocusInterp.Rate
    FocusInterpMaxDistance: 300,          // ESTIMATE FocusInterp.MaxDistance (uu)
    FocusOffsetInterpRate: 10,            // ESTIMATE FocusOffsetInterp.Rate
    DistanceInterpRate: 4,                // ESTIMATE DistanceInterp.Rate
    GroundRotationInterpRate: 12,         // ESTIMATE ground rotation follow rate on the floor
    GroundRotationInterpRateWall: 6,      // ESTIMATE ground rotation follow rate on walls
    WallNormalY: 0.7,                     // ESTIMATE surfaces flatter than this use the floor rate
    GroundNormalInterpRate: 10,           // ESTIMATE
    AirRotationInterpRate: 4,             // ESTIMATE air rotation follow rate
    AirFacingMinUp: 0.5,                  // ESTIMATE car facing counts in the air only while this upright
    AirVelocityInfluence: 0.5,            // ESTIMATE weight of velocity direction in the air rotation
    AirVelocityInfluenceMaxSpeed: 2300,   // ESTIMATE speed at which velocity influence is full
    DistanceSpeedScale: 114.7,            // MEASURED distance + (1 - stiffness) * 114.7 at max speed
    DistanceOffsetMin: 0,                 // ESTIMATE smallest speed distance offset (uu)
    SpeedPitchScale: 2,                   // MEASURED ScalePitch: Angle raised up to 2 deg at max speed, stiffness 0
    MaxSpeedFOV: 5,                       // MEASURED +5 deg approaching max speed
    FOVInterpSpeed: 3,                    // ESTIMATE (1/s)
    SupersonicFOV: 5,                     // MEASURED +5 deg more at supersonic
    SupersonicFOVInterpSpeed: 6,          // ESTIMATE (1/s)
    RollScale: 0.1,                       // ESTIMATE share of car roll the camera inherits
    BouncyChassisScale: 0.3,              // ESTIMATE share of chassis pitch (vs the surface) inherited on the ground
    ProximityDistance: 600,               // ESTIMATE
    ProximityDetectionSpeedCap: 1000,     // ESTIMATE
    ProximityDistanceMultiplier: 0,       // ESTIMATE 0 = off until measured
    ProximityDistanceBlendInSpeed: 3,     // ESTIMATE
    ProximityDistanceBlendOutSpeed: 1.5,  // ESTIMATE
    ProximityDistanceLimits: [0, 150],    // ESTIMATE
    // ---- CameraState_BallCam_TA
    RotationRate: 9,                      // ESTIMATE CurrRotToBall follow rate
    PitchScale: 0.6,                      // ESTIMATE
    PitchFocusZFactor: 0.1,               // ESTIMATE focus raised by this share of the ball's height difference
    PitchExtentMin: -50,                  // ESTIMATE deg
    PitchExtentMax: 50,                   // ESTIMATE deg
    // ---- Camera_TA
    SwivelDegPerSecond: 90 / 1.3,         // MEASURED 1.3 s per 90 deg at swivel speed 1, linear in the setting
    SwivelExtentSlow: { PitchMin: -35, PitchMax: 35, YawMax: 170 }, // ESTIMATE deg
    SwivelExtentFast: { PitchMin: -25, PitchMax: 25, YawMax: 120 }, // ESTIMATE deg
    SwivelFastSpeed: 1400,                // ESTIMATE uu/s where the fast extents apply fully
    SwivelDieRate: 8,                     // ESTIMATE swivel decay after release (1/s)
    GroundClampZOffset: 20,               // ESTIMATE uu above the floor
    ClipRate: 10,                         // ESTIMATE clip lift release rate (1/s)
    // ---- CameraState_Car_TA.StaticOverrideBlendParams
    BlendTimeAtTransition1: 0.5,          // ESTIMATE s at transition speed 1
    BlendTimeAtTransition2: 0.25          // ESTIMATE s at transition speed 2
  };

  const expAlpha = (rate, dt) => 1 - Math.exp(-rate * dt);
  const vec = (x, y, z) => new THREE.Vector3(x || 0, y || 0, z || 0);
  const flatten = (v, n) => v.clone().addScaledVector(n, -v.dot(n));
  const forwardOf = q => vec(0, 0, -1).applyQuaternion(q);
  const upOf = q => vec(0, 1, 0).applyQuaternion(q);
  const rightOf = q => vec(1, 0, 0).applyQuaternion(q);
  const axisAngle = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);

  function anyPerpendicular(n) {
    const h = flatten(vec(0, 0, 1), n);
    return (h.lengthSq() > 1e-4 ? h : flatten(vec(1, 0, 0), n)).normalize();
  }

  // Camera rotation looking along heading (perpendicular to up) with no pitch
  const _m = new THREE.Matrix4();
  function frameQuat(heading, up) {
    const right = vec().crossVectors(heading, up).normalize();
    const fwd = vec().crossVectors(up, right).normalize();
    _m.makeBasis(right, up.clone().normalize(), fwd.negate());
    return new THREE.Quaternion().setFromRotationMatrix(_m);
  }

  class ChaseCamera {
    constructor(aspect) {
      this.camera = new THREE.PerspectiveCamera(70, aspect, 10, 150000);
      this.ballCam = false;
      this.hfov = null;
      this.replayPos = null;
      this.replayLook = null;
      this.reset();
    }

    get settings() { return Game.Settings.get('camera'); }

    setAspect(aspect) {
      this.camera.aspect = aspect;
      if (this.hfov !== null) this.setHorizontalFov(this.hfov);
      else this.camera.updateProjectionMatrix();
    }

    // Vertical FOV for the menu and replay shots
    applyFov(fov) {
      this.hfov = null;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // RL FOV: horizontal at 16:9; wider screens keep that vertical FOV and see more to the sides
    setHorizontalFov(hfov) {
      this.hfov = hfov;
      const aspect = Math.min(this.camera.aspect, 16 / 9);
      this.camera.fov = 2 * Math.atan(Math.tan(hfov * DEG / 2) / aspect) / DEG;
      this.camera.updateProjectionMatrix();
    }

    toggleBallCam() { this.ballCam = !this.ballCam; return this.ballCam; }

    reset() {
      this.init = false;
      this.transition = null;
      this.lastState = null;
      this.lastPOV = null;
      this.ballRot = null;
      this.swivelYaw = 0;
      this.swivelPitch = 0;
      this.mouseIdle = Infinity;
      this.replayPos = null;
    }

    snap(carPos, carFwd, carUp, onGround, groundNormal, ballPos) {
      const s = this.settings;
      this.groundNormal = (groundNormal || (onGround ? carUp : WORLD_UP)).clone().normalize();
      const g = flatten(carFwd, this.groundNormal);
      this.groundRot = frameQuat(g.lengthSq() > 1e-4 ? g.normalize() : anyPerpendicular(this.groundNormal), this.groundNormal);
      const a = flatten(carFwd, WORLD_UP);
      this.airDir = a.lengthSq() > 1e-4 ? a.normalize() : vec(0, 0, 1);
      this.airRot = frameQuat(this.airDir, WORLD_UP);
      this.airGroundBlend = onGround ? 0 : 1;
      this.focus = carPos.clone();
      this.focusOffset = upOf(this.groundRot.clone().slerp(this.airRot, this.airGroundBlend)).multiplyScalar(s.height);
      this.distance = s.distance;
      this.fov = s.fov;
      this.proximity = 0;
      this.clipLift = 0;
      this.currBallLocation = ballPos.clone();
      this.oldBallLocation = ballPos.clone();
      this.ballRot = null;
      this.init = true;
    }

    update(dt, carPos, carQuat, carSpeed, ballPos, input, shake, opts) {
      opts = opts || {};
      const s = this.settings;
      this.replayPos = null;

      // 1-2. Car transform, velocity, grounded state
      const onGround = !!opts.onGround;
      const vel = opts.velocity || vec();
      const speed01 = clamp(carSpeed / CAR_MAX_SPEED, 0, 1);
      const flexible = 1 - clamp(s.stiffness, 0, 1);
      const carFwd = vec(1, 0, 0).applyQuaternion(carQuat);
      const carUp = vec(0, 1, 0).applyQuaternion(carQuat);
      if (!this.init || this.focus.distanceToSquared(carPos) > 1500 * 1500) this.snap(carPos, carFwd, carUp, onGround, opts.groundNormal, ballPos);

      // 3-4. Contacted surface normal, smoothed (held in the air)
      if (onGround && opts.groundNormal) this.groundNormal.lerp(opts.groundNormal, expAlpha(CFG.GroundNormalInterpRate, dt)).normalize();
      const groundNormal = this.groundNormal;

      // 5-6. GetCarFacingRotation + UpdateGroundPOV: the car's facing along the surface, followed at the
      // floor or wall rate while grounded
      if (onGround) {
        const facing = flatten(carFwd, groundNormal);
        if (facing.lengthSq() > 0.02) {
          const rate = groundNormal.y < CFG.WallNormalY ? CFG.GroundRotationInterpRateWall : CFG.GroundRotationInterpRate;
          this.groundRot.slerp(frameQuat(facing.normalize(), groundNormal), expAlpha(rate, dt));
        }
      }

      // 7. CalculateDesiredAirRotation + UpdateAirPOV: car facing (only while roughly upright, so flips and
      // tumbles don't drag the view) blended toward the velocity direction by speed
      const facingAir = flatten(carFwd, WORLD_UP);
      if (carUp.y > CFG.AirFacingMinUp && facingAir.lengthSq() > 0.09) this.airDir = facingAir.normalize();
      let airDir = this.airDir.clone();
      const velFlat = vec(vel.x, 0, vel.z), velFlatLen = velFlat.length();
      if (velFlatLen > 1) {
        const influence = CFG.AirVelocityInfluence * clamp(vel.length() / CFG.AirVelocityInfluenceMaxSpeed, 0, 1);
        const mixed = airDir.clone().lerp(velFlat.divideScalar(velFlatLen), influence);
        if (mixed.lengthSq() > 1e-4) airDir = mixed.normalize();
      }
      this.airRot.slerp(frameQuat(airDir, WORLD_UP), expAlpha(CFG.AirRotationInterpRate, dt));

      // 8. UpdateAirGroundBlend (0 = ground camera, 1 = air camera), separate rates each way
      this.airGroundBlend += ((onGround ? 0 : 1) - this.airGroundBlend) * expAlpha(onGround ? CFG.InterpToGroundRate : CFG.InterpToAirRate, dt);

      // 9. UpdateAirAndGroundCamera
      const frame = this.groundRot.clone().slerp(this.airRot, this.airGroundBlend);
      const up = upOf(frame), heading = forwardOf(frame);

      // 10-12. UpdateFocusWorldOffset + UpdateFocus: focus trails the car, offset follows the camera up
      this.focus.lerp(carPos, expAlpha(CFG.FocusInterpRate, dt));
      const lag = vec().subVectors(this.focus, carPos);
      if (lag.length() > CFG.FocusInterpMaxDistance) this.focus.copy(carPos).addScaledVector(lag.normalize(), CFG.FocusInterpMaxDistance);
      this.focusOffset.lerp(up.clone().multiplyScalar(s.height), expAlpha(CFG.FocusOffsetInterpRate, dt));

      // 13-15. UpdateDistance: speed offset scaled by (1 - stiffness), then smoothed
      const speedOffset = Math.max(CFG.DistanceOffsetMin, CFG.DistanceSpeedScale * speed01);
      this.distance += (s.distance + flexible * speedOffset - this.distance) * expAlpha(CFG.DistanceInterpRate, dt);

      // 16-18. Height, Angle (ScalePitch) and UpdateRotationModifiers -> base car POV
      const focus = this.focus.clone().add(this.focusOffset);
      const carUpInView = flatten(carUp, heading);
      const roll = carUpInView.lengthSq() > 1e-4 ? Math.asin(clamp(vec().crossVectors(up, carUpInView.normalize()).dot(heading), -1, 1)) : 0;
      const chassisPitch = Math.asin(clamp(carFwd.dot(up), -1, 1)) * (1 - this.airGroundBlend);
      const pitch = (s.angle + flexible * CFG.SpeedPitchScale * speed01) * DEG + chassisPitch * CFG.BouncyChassisScale;
      const carRot = axisAngle(heading, roll * CFG.RollScale).multiply(axisAngle(rightOf(frame), pitch).multiply(frame));

      // 19. CameraState_BallCam_TA on top of the base POV
      this.oldBallLocation.copy(this.currBallLocation);
      this.currBallLocation.copy(ballPos);
      const toBall = vec().subVectors(this.currBallLocation, focus);
      const heightDiff = toBall.dot(up);
      const flatToBall = flatten(toBall, up), flatLen = flatToBall.length();
      const rawPitch = Math.atan2(heightDiff, Math.max(flatLen, 1));
      const ballPitch = clamp(rawPitch * CFG.PitchScale, CFG.PitchExtentMin * DEG, CFG.PitchExtentMax * DEG) + pitch;
      const ballFrame = frameQuat(flatLen > 1 ? flatToBall.divideScalar(flatLen) : heading, up);
      const desiredBallRot = axisAngle(rightOf(ballFrame), ballPitch).multiply(ballFrame);
      if (!this.ballRot) this.ballRot = desiredBallRot;
      else this.ballRot.slerp(desiredBallRot, expAlpha(CFG.RotationRate, dt));
      const ballFocus = focus.clone().addScaledVector(up, heightDiff * CFG.PitchFocusZFactor);

      // Cam switch: fade out the difference between the old and new POV over the transition time
      const state = this.ballCam ? 'ball' : 'car';
      const target = state === 'ball' ? { focus: ballFocus, rot: this.ballRot.clone() } : { focus, rot: carRot };
      if (this.lastState !== null && state !== this.lastState && this.lastPOV) {
        const t = clamp(s.transitionSpeed - 1, 0, 1);
        this.transition = {
          elapsed: 0,
          time: lerp(CFG.BlendTimeAtTransition1, CFG.BlendTimeAtTransition2, t),
          rot: this.lastPOV.rot.clone().multiply(target.rot.clone().invert()),
          focus: vec().subVectors(this.lastPOV.focus, target.focus)
        };
      }
      this.lastState = state;
      const pov = { focus: target.focus.clone(), rot: target.rot.clone() };
      if (this.transition) {
        const tr = this.transition;
        tr.elapsed += dt;
        const a = clamp(tr.elapsed / tr.time, 0, 1);
        const keep = 1 - a * a * (3 - 2 * a);
        pov.rot.premultiply(new THREE.Quaternion().slerp(tr.rot, keep));
        pov.focus.addScaledVector(tr.focus, keep);
        if (a >= 1) this.transition = null;
      }
      this.lastPOV = pov;

      // 20. Swivel (Camera_TA.GetDesiredSwivel / UpdateSwivel / ApplySwivel)
      this.updateSwivel(dt, input, s, carSpeed);
      const rot = axisAngle(up, -this.swivelYaw).multiply(pov.rot);
      rot.premultiply(axisAngle(rightOf(rot), this.swivelPitch));

      // 21-23. UpdateFOV: speed FOV, supersonic FOV, smoothed
      const desiredFov = s.fov + CFG.MaxSpeedFOV * speed01 + (opts.supersonic ? CFG.SupersonicFOV : 0);
      this.fov += (desiredFov - this.fov) * expAlpha(opts.supersonic ? CFG.SupersonicFOVInterpSpeed : CFG.FOVInterpSpeed, dt);

      // 24. UpdateProximityDistance
      let proximityTarget = 0;
      if (CFG.ProximityDistanceMultiplier > 0 && carSpeed < CFG.ProximityDetectionSpeedCap) {
        const d = ballPos.distanceTo(carPos);
        if (d < CFG.ProximityDistance) {
          proximityTarget = clamp((CFG.ProximityDistance - d) * CFG.ProximityDistanceMultiplier, CFG.ProximityDistanceLimits[0], CFG.ProximityDistanceLimits[1]);
        }
      }
      const blendSpeed = proximityTarget > this.proximity ? CFG.ProximityDistanceBlendInSpeed : CFG.ProximityDistanceBlendOutSpeed;
      this.proximity += (proximityTarget - this.proximity) * expAlpha(blendSpeed, dt);

      // 25. ClipToField: lift above the floor immediately, let go at ClipRate
      const location = pov.focus.clone().addScaledVector(forwardOf(rot), -(this.distance + this.proximity));
      const need = Math.max(0, CFG.GroundClampZOffset - location.y);
      this.clipLift = need > this.clipLift ? need : this.clipLift + (need - this.clipLift) * expAlpha(CFG.ClipRate, dt);
      location.y += this.clipLift;

      // 26-27. Shake, output
      if (shake) location.add(shake);
      if (this.hfov === null || Math.abs(this.hfov - this.fov) > 0.01) this.setHorizontalFov(this.fov);
      this.camera.position.copy(location);
      this.camera.quaternion.copy(rot);
      this.camera.up.copy(upOf(rot));
    }

    // Stick: the view turns toward the stick's target angle at the swivel speed, within extents that
    // narrow from slow to fast. Mouse: drives the view directly. Released: swivel decays at SwivelDieRate.
    updateSwivel(dt, input, s, carSpeed) {
      const k = clamp(carSpeed / CFG.SwivelFastSpeed, 0, 1);
      const slow = CFG.SwivelExtentSlow, fast = CFG.SwivelExtentFast;
      const yawMax = lerp(slow.YawMax, fast.YawMax, k) * DEG;
      const pitchMin = lerp(slow.PitchMin, fast.PitchMin, k) * DEG;
      const pitchMax = lerp(slow.PitchMax, fast.PitchMax, k) * DEG;
      const invert = s.invertSwivel ? -1 : 1;
      let lookX = 0, lookY = 0;
      if (input) { const l = input.look(); lookX = l.x; lookY = l.y * invert; }

      if (Math.abs(lookX) > 0.05 || Math.abs(lookY) > 0.05) {
        const step = CFG.SwivelDegPerSecond * s.swivelSpeed * DEG * dt;
        const desiredYaw = lookX * yawMax;
        const desiredPitch = lookY >= 0 ? lookY * pitchMax : -lookY * pitchMin;
        this.swivelYaw += clamp(desiredYaw - this.swivelYaw, -step, step);
        this.swivelPitch += clamp(desiredPitch - this.swivelPitch, -step, step);
        this.mouseIdle = Infinity;
      } else if (input && input.pointerLocked && (input.mouseDX || input.mouseDY)) {
        this.swivelYaw = clamp(this.swivelYaw + input.mouseDX * 0.0006 * s.swivelSpeed, -Math.PI, Math.PI);
        this.swivelPitch = clamp(this.swivelPitch - input.mouseDY * 0.0004 * s.swivelSpeed * invert, pitchMin, pitchMax);
        this.mouseIdle = 0;
      } else {
        this.mouseIdle += dt;
        if (this.mouseIdle > 0.2) {
          const die = Math.exp(-CFG.SwivelDieRate * dt);
          this.swivelYaw *= die;
          this.swivelPitch *= die;
        }
      }
    }

    // Replay director: chase shot behind the car looking at the ball, cutting to a wide shot
    // beside the goal for the final moments. timeToGoal < 0 after the goal.
    updateReplay(dt, carPos, ballPos, goalPos, timeToGoal, shake) {
      let pos, look;
      if (timeToGoal > 1.4) {
        const dir = new THREE.Vector3(ballPos.x - carPos.x, 0, ballPos.z - carPos.z);
        if (dir.lengthSq() < 1) dir.set(0, 0, 1);
        dir.normalize();
        pos = new THREE.Vector3(carPos.x - dir.x * 520, carPos.y + 230, carPos.z - dir.z * 520);
        look = ballPos.clone().lerp(carPos, 0.25);
      } else {
        const side = ballPos.x >= 0 ? 1 : -1;
        const toField = -Math.sign(goalPos.z);
        pos = new THREE.Vector3(side * 2300, 950, goalPos.z + toField * 1900);
        look = ballPos.clone();
      }
      const cut = !this.replayPos || this.replayPos.distanceTo(pos) > 2500;
      if (cut) {
        this.replayPos = pos.clone();
        this.replayLook = look.clone();
      } else {
        this.replayPos.lerp(pos, 1 - Math.exp(-5 * dt));
        this.replayLook.lerp(look, 1 - Math.exp(-9 * dt));
      }
      const p = this.replayPos.clone(), l = this.replayLook.clone();
      p.y = Math.max(p.y, 40);
      if (shake) p.add(shake);
      if (this.hfov !== null || this.camera.fov !== 80) this.applyFov(80);
      this.camera.position.copy(p);
      this.camera.up.copy(WORLD_UP);
      this.camera.lookAt(l);
    }
  }

  return { ChaseCamera, CFG };
})();
