// Rocket League camera. The structure follows RL's own camera classes as listed in the game's generated
// SDK (TAGame CameraState_Car_TA, CameraState_BallCam_TA, Camera_TA; ProjectX CameraStateBlender_X):
//  - a POV is { Focus, Rotation, Distance, FOV } and the camera sits at Focus - forward * Distance
//  - car cam builds a ground POV (heading along the surface the wheels touch) and an air POV (world up,
//    heading kept from the last ground contact) and blends them with AirGroundBlend
//  - Focus trails the car (FocusInterp), Height lifts it along the view's up, Distance stretches with
//    velocity along the view (UpdateDistance), FOV rises with speed and again at supersonic (UpdateFOV),
//    and the Angle setting is raised with speed (ScalePitch)
//  - ball cam keeps the car cam's focus, distance and FOV but turns onto the ball, with its pitch scaled
//    and clamped (RotationRate, PitchScale, PitchExtentMin/Max)
//  - switching cams fades out the difference between the old and new POV (TransitionDelta)
//  - swivel orbits the focus at the swivel speed and returns when released (Camera_TA.UpdateSwivel), and
//    the camera is kept above the floor (ClipToField)
// The SDK gives names and structure but no values. CFG marks each number MEASURED (published community
// measurements) or ESTIMATE (to be replaced by measurements of real gameplay recordings).
// RL's FOV setting is horizontal at 16:9 (Hor+ on wider screens). three.js coordinates (Y up), uu.
window.Game = window.Game || {};

Game.ChaseCamera = (function () {
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const DEG = Math.PI / 180;
  const CAR_MAX_SPEED = 2300;
  const clamp = THREE.MathUtils.clamp;

  const CFG = {
    // CameraState_Car_TA
    InterpToGroundRate: 8,              // ESTIMATE air -> ground POV blend rate (1/s)
    InterpToAirRate: 3,                 // ESTIMATE ground -> air
    FocusRate: 20,                      // FocusInterp lag tau = (1 - stiffness) / FocusRate (car-soccer measurement)
    FocusMaxDistance: 300,              // ESTIMATE FocusInterp.MaxDistance
    GroundRotationInterpRate: 14,       // ESTIMATE heading follow rate on the floor
    GroundRotationInterpRateWall: 8,    // ESTIMATE heading follow rate on walls
    StiffnessRotationScale: 3,          // ESTIMATE rotation rate * (1 + scale * stiffness); stiffness 1 is rigid
    GroundNormalInterpRate: 10,         // ESTIMATE
    AirVelocityInfluence: 0,            // ESTIMATE 0 keeps the last grounded heading in the air
    AirVelocityInfluenceMaxSpeed: 2300, // ESTIMATE
    DistanceSpeedScale: 114.7,          // MEASURED distance + (1 - stiffness) * 114.7 at max speed
    DistanceOffsetMin: 0,               // ESTIMATE lowest velocity ratio used for distance
    DistanceInterpRate: 4,              // ESTIMATE
    SpeedPitchScale: 2,                 // MEASURED angle raised up to 2 deg at max speed, stiffness 0
    MaxSpeedFOV: 5,                     // MEASURED +5 deg approaching max speed
    SupersonicFOV: 5,                   // MEASURED +5 deg more at supersonic
    FOVInterpSpeed: 10,                 // ESTIMATE deg/s
    SupersonicFOVInterpSpeed: 20,       // ESTIMATE deg/s
    // CameraState_BallCam_TA
    RotationRate: 9,                    // ESTIMATE (car-soccer measured ~0.11 s yaw lag)
    PitchScale: 0.6,                    // ESTIMATE
    PitchExtentMin: -50,                // ESTIMATE deg
    PitchExtentMax: 50,                 // ESTIMATE deg
    // Camera_TA
    SwivelDegPerSecond: 90 / 1.3,       // MEASURED 1.3 s per 90 deg at swivel speed 1, linear in the setting
    SwivelYawMax: 170,                  // ESTIMATE deg at full stick
    SwivelPitchMax: 35,                 // ESTIMATE deg at full stick
    SwivelDieRateScale: 1,              // ESTIMATE return speed relative to swivel speed
    GroundClampZOffset: 20,             // ESTIMATE uu above the floor
    // CameraState_Car_TA.StaticOverrideBlendParams
    BlendTimeAtTransition1: 0.5,        // ESTIMATE s at transition speed 1
    BlendTimeAtTransition2: 0.25        // ESTIMATE s at transition speed 2
  };

  const expAlpha = (rate, dt) => 1 - Math.exp(-rate * dt);
  const towards = (cur, target, maxStep) => cur + clamp(target - cur, -maxStep, maxStep);
  const vec = (x, y, z) => new THREE.Vector3(x || 0, y || 0, z || 0);

  function flatten(v, n) { return v.clone().addScaledVector(n, -v.dot(n)); }

  function anyPerpendicular(n) {
    const h = flatten(vec(0, 0, 1), n);
    return (h.lengthSq() > 1e-4 ? h : flatten(vec(1, 0, 0), n)).normalize();
  }

  // Rotates unit h (perpendicular to up) toward unit d by fraction t of the signed angle between them
  function turnToward(h, d, up, t) {
    const ang = Math.atan2(vec().crossVectors(h, d).dot(up), h.dot(d));
    return h.applyAxisAngle(up, ang * t).normalize();
  }

  // Camera rotation looking along heading (perpendicular to up), raised by pitch radians
  const _m = new THREE.Matrix4();
  function viewQuat(heading, up, pitch) {
    const fwd = heading.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch));
    const right = vec().crossVectors(fwd, up).normalize();
    const camUp = vec().crossVectors(right, fwd).normalize();
    _m.makeBasis(right, camUp, fwd.negate());
    return new THREE.Quaternion().setFromRotationMatrix(_m);
  }

  const forwardOf = q => vec(0, 0, -1).applyQuaternion(q);
  const upOf = q => vec(0, 1, 0).applyQuaternion(q);
  const rightOf = q => vec(1, 0, 0).applyQuaternion(q);

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
      this.ballHeading = null;
      this.swivelYaw = 0;
      this.swivelPitch = 0;
      this.desiredYaw = 0;
      this.desiredPitch = 0;
      this.mouseIdle = 0;
      this.replayPos = null;
    }

    snap(carPos, carFwd, carUp, onGround, groundNormal) {
      const s = this.settings;
      this.focus = carPos.clone();
      this.groundNormal = (groundNormal || carUp).clone().normalize();
      this.groundHeading = flatten(carFwd, this.groundNormal);
      this.groundHeading = this.groundHeading.lengthSq() > 1e-4 ? this.groundHeading.normalize() : anyPerpendicular(this.groundNormal);
      const air = flatten(this.groundHeading, WORLD_UP);
      this.airHeading = air.lengthSq() > 1e-4 ? air.normalize() : vec(0, 0, 1);
      this.airGroundBlend = onGround ? 1 : 0;
      this.distance = s.distance;
      this.fov = s.fov;
      this.ballHeading = null;
      this.init = true;
    }

    update(dt, carPos, carQuat, carSpeed, ballPos, input, shake, opts) {
      opts = opts || {};
      const s = this.settings;
      const stiff = clamp(s.stiffness, 0, 1);
      const rigid = stiff >= 0.999;
      const onGround = !!opts.onGround;
      const vel = opts.velocity || vec();
      const speedRatio = clamp(carSpeed / CAR_MAX_SPEED, 0, 1);
      const carFwd = vec(1, 0, 0).applyQuaternion(carQuat);
      const carUp = vec(0, 1, 0).applyQuaternion(carQuat);
      this.replayPos = null;

      if (!this.init || this.focus.distanceToSquared(carPos) > 1500 * 1500) this.snap(carPos, carFwd, carUp, onGround, opts.groundNormal);

      // ---- UpdateAirGroundBlend
      this.airGroundBlend += ((onGround ? 1 : 0) - this.airGroundBlend) * expAlpha(onGround ? CFG.InterpToGroundRate : CFG.InterpToAirRate, dt);

      // ---- UpdateGroundPOV: heading follows the car's nose along the surface under the wheels
      if (onGround && opts.groundNormal) {
        this.groundNormal.lerp(opts.groundNormal, rigid ? 1 : expAlpha(CFG.GroundNormalInterpRate, dt)).normalize();
      }
      const groundUp = this.groundNormal;
      this.groundHeading = flatten(this.groundHeading, groundUp);
      this.groundHeading = this.groundHeading.lengthSq() > 1e-6 ? this.groundHeading.normalize() : anyPerpendicular(groundUp);
      if (onGround) {
        const target = flatten(carFwd, groundUp);
        if (target.lengthSq() > 1e-4) {
          const rate = (groundUp.y < 0.7 ? CFG.GroundRotationInterpRateWall : CFG.GroundRotationInterpRate) * (1 + CFG.StiffnessRotationScale * stiff);
          turnToward(this.groundHeading, target.normalize(), groundUp, rigid ? 1 : expAlpha(rate, dt));
        }
      }

      // ---- UpdateAirPOV: world up, heading kept from the last ground contact
      if (onGround) {
        const h = flatten(this.groundHeading, WORLD_UP);
        if (h.lengthSq() > 0.01) this.airHeading = h.normalize();
      } else if (CFG.AirVelocityInfluence > 0) {
        const v2 = vec(vel.x, 0, vel.z), sp = v2.length();
        if (sp > 1) {
          const rate = CFG.AirVelocityInfluence * Math.min(1, sp / CFG.AirVelocityInfluenceMaxSpeed);
          turnToward(this.airHeading, v2.divideScalar(sp), WORLD_UP, expAlpha(rate, dt));
        }
      }

      // ---- UpdateAirAndGroundCamera + ScalePitch
      const pitch = (s.angle + (1 - stiff) * CFG.SpeedPitchScale * speedRatio) * DEG;
      const flatQuat = viewQuat(this.airHeading, WORLD_UP, 0).slerp(viewQuat(this.groundHeading, groundUp, 0), this.airGroundBlend);
      const up = upOf(flatQuat), heading = forwardOf(flatQuat);
      const carRot = viewQuat(this.airHeading, WORLD_UP, pitch).slerp(viewQuat(this.groundHeading, groundUp, pitch), this.airGroundBlend);

      // ---- UpdateFocus: trail the car, then lift by Height
      if (rigid) {
        this.focus.copy(carPos);
      } else {
        this.focus.lerp(carPos, expAlpha(CFG.FocusRate / (1 - stiff), dt));
        const off = vec().subVectors(this.focus, carPos);
        if (off.length() > CFG.FocusMaxDistance) this.focus.copy(carPos).addScaledVector(off.normalize(), CFG.FocusMaxDistance);
      }
      const focus = this.focus.clone().addScaledVector(up, s.height);

      // ---- UpdateDistance: stretch with velocity along the view
      const along = clamp(vel.dot(heading) / CAR_MAX_SPEED, CFG.DistanceOffsetMin, 1);
      const targetDistance = s.distance + (1 - stiff) * CFG.DistanceSpeedScale * along;
      this.distance += (targetDistance - this.distance) * expAlpha(CFG.DistanceInterpRate, dt);

      // ---- UpdateFOV
      const targetFov = s.fov + CFG.MaxSpeedFOV * speedRatio + (opts.supersonic ? CFG.SupersonicFOV : 0);
      this.fov = towards(this.fov, targetFov, (opts.supersonic ? CFG.SupersonicFOVInterpSpeed : CFG.FOVInterpSpeed) * dt);

      // ---- CameraState_BallCam_TA: yaw onto the ball, pitch scaled and clamped
      const toBall = vec().subVectors(ballPos, focus);
      const flat = flatten(toBall, up), flatLen = flat.length();
      const pitchToBall = Math.atan2(toBall.dot(up), Math.max(flatLen, 1e-3));
      if (this.ballHeading) this.ballHeading = flatten(this.ballHeading, up);
      if (!this.ballHeading || this.ballHeading.lengthSq() < 1e-6) {
        this.ballHeading = flatLen > 1 ? flat.clone().divideScalar(flatLen) : heading.clone();
        this.ballPitch = pitchToBall;
      }
      this.ballHeading.normalize();
      const turn = expAlpha(CFG.RotationRate, dt);
      if (flatLen > 1) turnToward(this.ballHeading, flat.divideScalar(flatLen), up, turn);
      this.ballPitch += (pitchToBall - this.ballPitch) * turn;
      const ballRot = viewQuat(this.ballHeading, up, clamp(this.ballPitch * CFG.PitchScale, CFG.PitchExtentMin * DEG, CFG.PitchExtentMax * DEG) + pitch);

      // ---- CameraStateBlender_X: fade out the difference between the old and new POV
      const state = this.ballCam ? 'ball' : 'car';
      const target = { focus, rot: state === 'ball' ? ballRot : carRot, distance: this.distance, fov: this.fov };
      if (this.lastState !== null && state !== this.lastState && this.lastPOV) {
        const t = clamp(s.transitionSpeed - 1, 0, 1);
        this.transition = {
          elapsed: 0,
          time: CFG.BlendTimeAtTransition1 + (CFG.BlendTimeAtTransition2 - CFG.BlendTimeAtTransition1) * t,
          rot: this.lastPOV.rot.clone().multiply(target.rot.clone().invert()),
          distance: this.lastPOV.distance - target.distance,
          fov: this.lastPOV.fov - target.fov
        };
      }
      this.lastState = state;
      const pov = { focus: target.focus, rot: target.rot.clone(), distance: target.distance, fov: target.fov };
      if (this.transition) {
        const tr = this.transition;
        tr.elapsed += dt;
        const a = clamp(tr.elapsed / tr.time, 0, 1);
        const keep = 1 - a * a * (3 - 2 * a);
        pov.rot.premultiply(new THREE.Quaternion().slerp(tr.rot, keep));
        pov.distance += tr.distance * keep;
        pov.fov += tr.fov * keep;
        if (a >= 1) this.transition = null;
      }
      this.lastPOV = pov;

      // ---- Camera_TA.UpdateSwivel / ApplySwivel
      this.updateSwivel(dt, input, s);
      const swiveled = new THREE.Quaternion().setFromAxisAngle(up, -this.swivelYaw).multiply(pov.rot);
      swiveled.premultiply(new THREE.Quaternion().setFromAxisAngle(rightOf(swiveled), this.swivelPitch));

      // ---- final location, ClipToField
      const location = pov.focus.clone().addScaledVector(forwardOf(swiveled), -pov.distance);
      location.y = Math.max(location.y, CFG.GroundClampZOffset);
      if (shake) location.add(shake);

      if (this.hfov === null || Math.abs(this.hfov - pov.fov) > 0.01) this.setHorizontalFov(pov.fov);
      this.camera.position.copy(location);
      this.camera.quaternion.copy(swiveled);
      this.camera.up.copy(upOf(swiveled));
    }

    // Stick sets a target view angle that the camera turns to at the swivel speed; the mouse drives the
    // view directly. Released, the view returns at the swivel die rate.
    updateSwivel(dt, input, s) {
      const invert = s.invertSwivel ? -1 : 1;
      const step = CFG.SwivelDegPerSecond * s.swivelSpeed * DEG * dt;
      let lookX = 0, lookY = 0;
      if (input) { const l = input.look(); lookX = l.x; lookY = l.y; }

      if (Math.abs(lookX) > 0.05 || Math.abs(lookY) > 0.05) {
        this.desiredYaw = lookX * CFG.SwivelYawMax * DEG;
        this.desiredPitch = lookY * invert * CFG.SwivelPitchMax * DEG;
        this.mouseIdle = Infinity; // releasing the stick returns straight away; only the mouse waits
        this.swivelYaw = towards(this.swivelYaw, this.desiredYaw, step);
        this.swivelPitch = towards(this.swivelPitch, this.desiredPitch, step);
      } else if (input && input.pointerLocked && (input.mouseDX || input.mouseDY)) {
        this.swivelYaw = clamp(this.swivelYaw + input.mouseDX * 0.0006 * s.swivelSpeed, -Math.PI, Math.PI);
        this.swivelPitch = clamp(this.swivelPitch - input.mouseDY * 0.0004 * s.swivelSpeed * invert, -CFG.SwivelPitchMax * DEG, CFG.SwivelPitchMax * DEG);
        this.mouseIdle = 0;
      } else {
        this.mouseIdle += dt;
        if (this.mouseIdle > 0.2) {
          const release = step * CFG.SwivelDieRateScale;
          this.swivelYaw = towards(this.swivelYaw, 0, release);
          this.swivelPitch = towards(this.swivelPitch, 0, release);
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
