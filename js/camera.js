// Chase camera matching car-soccer.com's camera. Its code isn't licensed for reuse, so nothing is copied:
// this reproduces its behaviour from recordings of the live game (FOV 110, distance 270, height 100,
// angle -3, stiffness 0.35, swivel 4, transition 1), measured 2026-09-13 and 2026-09-14:
//  - the camera looks at a point Height above a pivot that trails the car by (1 - stiffness) * 0.05 s, from
//    Distance away, and is always oriented with world up: it never rolls, on walls or in the air
//  - car cam on the ground: the heading follows the car's nose with the same lag as the pivot, and the offset
//    and pitch use the surface under the wheels, so it rides walls without rolling
//  - car cam in the air: the heading slowly drifts toward the direction of travel (only at speed), so flips
//    and air rolls don't turn the view
//  - car cam pitch hangs off the look point like a camera on a rope: rising or falling drags it, and it eases
//    back to Angle (fast on the ground, slowly in the air)
//  - ball cam: yaw follows the ball with a 0.1 s lag; pitch stays at Angle until the ball is 9 deg below or
//    11 deg above the screen centre, then follows it, and the camera orbits the look point to match
//  - FOV: horizontal on landscape screens (portrait keeps the 16:9 vertical FOV); +5 deg with speed and a
//    further +5 deg at supersonic
//  - switching between car cam and ball cam blends at 9/s (times Transition Speed)
// Not measured (kept from earlier tuning): surface-normal smoothing, swivel, the floor clamp and the replay
// director. three.js coordinates (Y up), uu.
window.Game = window.Game || {};

Game.ChaseCamera = (function () {
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const DEG = Math.PI / 180;
  const clamp = THREE.MathUtils.clamp;
  const CAR_MAX_SPEED = 2300;

  const M = {
    trailPerFlex: 0.05,            // measured: pivot lag tau = (1 - stiffness) * 0.05 s, also the ground heading lag
    speedFov: 5,                   // measured: +5 deg horizontal at max speed
    speedFovRate: 10,              // measured (1/s)
    supersonicFov: 5,              // measured: +5 deg more while supersonic
    supersonicFovDegPerSec: 40,    // measured: the supersonic step takes ~0.13 s
    ropeRateGround: 20,            // measured: pitch eases back to Angle (1/s)
    ropeRateAir: 6,                // measured
    airHeadingRate: 2.5,           // measured: heading drift toward travel at max speed (1/s), scaled by speed
    ballYawRate: 10,               // measured: 0.1 s
    ballBandBelow: 9,              // measured (deg)
    ballBandAbove: 11,             // measured (deg)
    ballPitchRate: 20,             // measured (1/s)
    transitionRate: 9,             // measured at Transition Speed 1 (1/s)
    normalRateGround: 7,           // not measured
    normalRateAir: 2.5,            // not measured
    minHeight: 30                  // not measured
  };

  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
  const flatten = (v, n) => v.clone().addScaledVector(n, -v.dot(n));
  const pitched = (h, up, pitch) => h.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch));
  const elevation = (v, up) => Math.atan2(v.dot(up), Math.max(flatten(v, up).length(), 1e-6));

  // A unit vector perpendicular to n, as close as possible to pref
  function perpendicular(n, pref) {
    for (const v of [pref, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)]) {
      if (!v) continue;
      const h = flatten(v, n);
      if (h.lengthSq() > 1e-4) return h.normalize();
    }
    return new THREE.Vector3(0, 0, 1);
  }

  // Rotates unit h (perpendicular to up) toward unit d by fraction t of the signed angle between them.
  // Deterministic for opposite vectors, unlike a quaternion between unit vectors.
  function turnToward(h, d, up, t) {
    const ang = Math.atan2(new THREE.Vector3().crossVectors(h, d).dot(up), h.dot(d));
    return h.applyAxisAngle(up, ang * t).normalize();
  }

  function angleLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  class ChaseCamera {
    constructor(aspect) {
      this.camera = new THREE.PerspectiveCamera(70, aspect, 10, 150000);
      this.ballCam = false;
      this.hfov = null;
      this.swivelYaw = 0;
      this.swivelPitch = 0;
      this.mouseIdle = 0;
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

    // The FOV setting is horizontal on landscape screens; portrait screens keep the vertical FOV of 16:9
    setHorizontalFov(hfov) {
      this.hfov = hfov;
      const t = Math.tan(hfov * DEG / 2);
      const aspect = this.camera.aspect;
      this.camera.fov = 2 * Math.atan(aspect >= 1 ? t / aspect : t * 9 / 16) / DEG;
      this.camera.updateProjectionMatrix();
    }

    toggleBallCam() { this.ballCam = !this.ballCam; return this.ballCam; }

    reset() {
      this.init = false;
      this.replayPos = null;
    }

    snap(carPos, carFwd, ballPos, onGround, groundNormal) {
      const angle = this.settings.angle * DEG;
      this.pivot = carPos.clone();
      this.lastCarPos = carPos.clone();
      this.normal = (onGround && groundNormal ? groundNormal : WORLD_UP).clone().normalize();
      this.carHeading = perpendicular(this.normal, carFwd);
      this.carPitch = angle;
      this.carCamPos = null;
      this.ballHeading = perpendicular(WORLD_UP, ballPos.clone().sub(carPos).lengthSq() > 1 ? ballPos.clone().sub(carPos) : carFwd);
      this.ballPitch = angle;
      this.ballCamPos = null;
      this.blend = this.ballCam ? 1 : 0;
      this.speedFov = 0;
      this.sonicFov = 0;
      this.init = true;
    }

    // opts: { onGround, groundNormal (wheel contact normal, three.js axes), velocity (uu/s), supersonic }
    update(dt, carPos, carQuat, carSpeed, ballPos, input, shake, opts) {
      opts = opts || {};
      const s = this.settings;
      this.replayPos = null;
      const angle = s.angle * DEG;
      const onGround = !!opts.onGround;
      const vel = opts.velocity || new THREE.Vector3();
      const carFwd = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat);
      if (!this.init || this.pivot.distanceToSquared(carPos) > 1500 * 1500) this.snap(carPos, carFwd, ballPos, onGround, opts.groundNormal);

      // FOV: speed part eases, the supersonic step ramps
      this.speedFov += (M.speedFov * clamp(carSpeed / CAR_MAX_SPEED, 0, 1) - this.speedFov) * ease(M.speedFovRate, dt);
      const sonicStep = M.supersonicFovDegPerSec * dt;
      this.sonicFov += clamp((opts.supersonic ? M.supersonicFov : 0) - this.sonicFov, -sonicStep, sonicStep);
      const fov = s.fov + this.speedFov + this.sonicFov;
      if (this.hfov === null || Math.abs(this.hfov - fov) > 0.01) this.setHorizontalFov(fov);

      // Pivot trails the car as a first-order lag with time constant tau, integrated exactly over the car's
      // movement this frame, so the trail settles at velocity * tau at any frame rate
      const tau = (1 - clamp(s.stiffness, 0, 1)) * M.trailPerFlex;
      if (tau < 1e-4) {
        this.pivot.copy(carPos);
      } else if (dt > 0) {
        const k = Math.exp(-dt / tau);
        const lag = this.lastCarPos.clone().sub(this.pivot).multiplyScalar(k)
          .add(carPos.clone().sub(this.lastCarPos).multiplyScalar((tau / dt) * (1 - k)));
        this.pivot = carPos.clone().sub(lag);
      }
      this.lastCarPos.copy(carPos);

      // Surface normal: the wheels' contact normal on the ground, world up in the air
      this.normal.lerp(onGround && opts.groundNormal ? opts.groundNormal : WORLD_UP, ease(onGround ? M.normalRateGround : M.normalRateAir, dt)).normalize();
      const n = this.normal;

      // ---- car cam
      this.carHeading = perpendicular(n, this.carHeading);
      if (onGround) {
        const nose = flatten(carFwd, n);
        if (nose.lengthSq() > 1e-4) turnToward(this.carHeading, nose.normalize(), n, tau < 1e-4 ? 1 : ease(1 / tau, dt));
      } else {
        const travel = flatten(vel, n), sp = travel.length();
        if (sp > 1) turnToward(this.carHeading, travel.divideScalar(sp), n, ease(M.airHeadingRate * Math.min(1, sp / CAR_MAX_SPEED), dt));
      }
      const carOrigin = this.pivot.clone().addScaledVector(n, s.height);
      if (this.carCamPos) {
        // Only rising or falling drags the rope; moving along the surface keeps the camera at Angle
        const rise = carOrigin.clone().sub(this.carOrigin).dot(n);
        const rope = elevation(this.carOrigin.clone().sub(this.carCamPos).addScaledVector(n, rise), n);
        this.carPitch = rope + (angle - rope) * ease(onGround ? M.ropeRateGround : M.ropeRateAir, dt);
      } else {
        this.carPitch = angle;
      }
      this.carPitch = clamp(this.carPitch, -1.45, 1.45);
      const carDir = pitched(this.carHeading, n, this.carPitch);
      this.carCamPos = carOrigin.clone().addScaledVector(carDir, -s.distance);
      this.carOrigin = carOrigin;

      // ---- ball cam
      const ballOrigin = this.pivot.clone().addScaledVector(WORLD_UP, s.height);
      this.ballHeading = perpendicular(WORLD_UP, this.ballHeading);
      const toBall = flatten(ballPos.clone().sub(ballOrigin), WORLD_UP), toBallLen = toBall.length();
      if (toBallLen > 1) turnToward(this.ballHeading, toBall.divideScalar(toBallLen), WORLD_UP, ease(M.ballYawRate, dt));
      const seenFrom = this.ballCamPos || ballOrigin.clone().addScaledVector(pitched(this.ballHeading, WORLD_UP, angle), -s.distance);
      const ballElev = elevation(ballPos.clone().sub(seenFrom), WORLD_UP);
      const ballTarget = clamp(Math.min(Math.max(angle, ballElev - M.ballBandAbove * DEG), ballElev + M.ballBandBelow * DEG), -1.4, 1.4);
      this.ballPitch += (ballTarget - this.ballPitch) * ease(M.ballPitchRate, dt);
      const ballDir = pitched(this.ballHeading, WORLD_UP, this.ballPitch);
      this.ballCamPos = ballOrigin.clone().addScaledVector(ballDir, -s.distance);

      // ---- car cam <-> ball cam blend (0 = car cam, 1 = ball cam)
      const blendTarget = this.ballCam ? 1 : 0;
      this.blend += (blendTarget - this.blend) * ease(M.transitionRate * Math.max(0.1, s.transitionSpeed), dt);
      if (Math.abs(blendTarget - this.blend) < 1e-3) this.blend = blendTarget;
      let origin, dir;
      if (this.blend === 0) {
        origin = carOrigin; dir = carDir;
      } else if (this.blend === 1) {
        origin = ballOrigin; dir = ballDir;
      } else {
        origin = carOrigin.clone().lerp(ballOrigin, this.blend);
        const heading = perpendicular(WORLD_UP, carDir);
        turnToward(heading, perpendicular(WORLD_UP, ballDir), WORLD_UP, this.blend);
        dir = pitched(heading, WORLD_UP, THREE.MathUtils.lerp(elevation(carDir, WORLD_UP), elevation(ballDir, WORLD_UP), this.blend));
      }

      // ---- swivel
      this.updateSwivel(dt, input, s);
      if (this.swivelYaw || this.swivelPitch) {
        const heading = perpendicular(WORLD_UP, dir).applyAxisAngle(WORLD_UP, -this.swivelYaw);
        dir = pitched(heading, WORLD_UP, clamp(elevation(dir, WORLD_UP) + this.swivelPitch, -1.45, 1.45));
      }

      // ---- output: look through the look point, oriented with world up
      const pos = origin.clone().addScaledVector(dir, -s.distance);
      pos.y = Math.max(pos.y, M.minHeight);
      if (shake) pos.add(shake);
      this.camera.position.copy(pos);
      this.camera.up.copy(WORLD_UP);
      this.camera.lookAt(pos.clone().add(dir));
    }

    // Stick: turns toward the stick direction; mouse: drives the view directly; released: returns to centre
    updateSwivel(dt, input, s) {
      let lookX = 0, lookY = 0;
      if (input) { const l = input.look(); lookX = l.x; lookY = l.y; }
      const usingStick = Math.abs(lookX) > 0.05 || Math.abs(lookY) > 0.05;
      const invert = s.invertSwivel ? -1 : 1;
      const follow = ease(s.swivelSpeed * 2.5, dt);
      if (usingStick) {
        this.swivelYaw = angleLerp(this.swivelYaw, lookX * Math.PI * 0.95, follow);
        this.swivelPitch += (lookY * 0.55 * invert - this.swivelPitch) * follow;
        this.mouseIdle = 0;
      } else if (input && input.pointerLocked && (input.mouseDX || input.mouseDY)) {
        this.swivelYaw += input.mouseDX * 0.0006 * s.swivelSpeed;
        this.swivelPitch = clamp(this.swivelPitch - input.mouseDY * 0.0004 * s.swivelSpeed * invert, -0.6, 0.6);
        this.mouseIdle = 0;
      } else {
        this.mouseIdle += dt;
        if (this.mouseIdle > 0.2) {
          this.swivelYaw = angleLerp(this.swivelYaw, 0, follow);
          this.swivelPitch += -this.swivelPitch * follow;
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

  return { ChaseCamera, M };
})();
