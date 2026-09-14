// Rocket League style chase camera. RocketSim is physics-only and has no camera code, so this follows
// RL's camera settings (FOV, Distance, Height, Angle, Stiffness, Swivel Speed, Transition Speed) plus
// measurements of car-soccer.com's camera:
//  - the camera sits at pivot + up * height, pulled back by Distance along the view heading; the pivot
//    trails the car by (1 - stiffness) * 0.05s, so the camera stretches back as you accelerate
//  - car cam follows the car's heading and rides walls/ceilings with it; the heading is held during a
//    dodge so flips never spin the view
//  - ball cam locks its yaw onto the ball and aims from the camera at the ball (plus the Angle offset),
//    so the ball stays on the centre line: above the ball the camera rises and looks down at it, and it
//    only swings low under the car when the ball is well above you
//  - Transition Speed sets how quickly the view blends between car cam and ball cam
// Swivel (mouse, right stick or Look actions), camera shake and a replay director are included.
// three.js coordinates (Y up), uu.
window.Game = window.Game || {};

Game.ChaseCamera = (function () {
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const clamp = THREE.MathUtils.clamp;

  function flatten(v, n) { return v.clone().sub(n.clone().multiplyScalar(v.dot(n))); }
  function ease(rate, dt) { return 1 - Math.exp(-rate * dt); }
  function pitched(flat, up, pitch) { return flat.clone().multiplyScalar(Math.cos(pitch)).add(up.clone().multiplyScalar(Math.sin(pitch))); }
  function elevation(v, up) { return Math.atan2(v.dot(up), Math.max(flatten(v, up).length(), 1)); }

  function angleLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Rotates unit vector h (perpendicular to up) toward unit vector d by fraction t of the signed angle
  // between them. Deterministic for opposite vectors, unlike a quaternion between unit vectors.
  function turnToward(h, d, up, t) {
    const ang = Math.atan2(tmp.crossVectors(h, d).dot(up), h.dot(d));
    return h.applyAxisAngle(up, ang * t).normalize();
  }

  class ChaseCamera {
    constructor(aspect) {
      this.camera = new THREE.PerspectiveCamera(110, aspect, 10, 150000);
      this.ballCam = false;
      this.pivot = null;
      this.up = WORLD_UP.clone();
      this.carHeading = null;
      this.ballHeading = null;
      this.blend = null;
      this.orbit = null;
      this.aimWeight = 1;
      this.pitch = THREE.MathUtils.degToRad(-3);
      this.swivelYaw = 0;
      this.swivelPitch = 0;
      this.mouseIdle = 0;
      this.fovExtra = 0;
      this.replayPos = null;
      this.replayLook = null;
    }

    get settings() { return Game.Settings.get('camera'); }
    setAspect(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
    applyFov(fov) { this.camera.fov = fov !== undefined ? fov : this.settings.fov + this.fovExtra; this.camera.updateProjectionMatrix(); }
    toggleBallCam() { this.ballCam = !this.ballCam; return this.ballCam; }
    reset() {
      this.pivot = null;
      this.carHeading = null;
      this.ballHeading = null;
      this.blend = null;
      this.orbit = null;
      this.up.copy(WORLD_UP);
      this.replayPos = null;
    }

    update(dt, carPos, carQuat, carSpeed, ballPos, input, shake, opts) {
      opts = opts || {};
      const s = this.settings;
      this.replayPos = null;

      this.fovExtra += ((opts.supersonic ? 5 : 0) - this.fovExtra) * ease(4, dt);
      const fov = s.fov + this.fovExtra;
      if (Math.abs(this.camera.fov - fov) > 0.01) this.applyFov(fov);

      // Pivot trails the car
      const tau = (1 - s.stiffness) * 0.05;
      if (!this.pivot || tau < 1e-4 || this.pivot.distanceToSquared(carPos) > 1500 * 1500) this.pivot = carPos.clone();
      else this.pivot.lerp(carPos, 1 - Math.exp(-dt / tau));

      // Car cam <-> ball cam blend (0 = car cam, 1 = ball cam)
      const blendTarget = this.ballCam ? 1 : 0;
      if (this.blend === null) this.blend = blendTarget;
      this.blend += (blendTarget - this.blend) * ease(6 * Math.max(0.1, s.transitionSpeed), dt);
      if (Math.abs(blendTarget - this.blend) < 1e-3) this.blend = blendTarget;

      // Up vector: car cam rides surfaces with the car, otherwise world up
      const carUp = WORLD_UP.clone().applyQuaternion(carQuat);
      const carFwd = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat);
      const ride = !this.ballCam && opts.onGround;
      this.up.lerp(ride ? carUp : WORLD_UP, ease(ride ? 7 : 2.5, dt)).normalize();
      const up = this.up;

      const seed = () => {
        for (const v of [carFwd, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)]) {
          const h = flatten(v, up);
          if (h.lengthSq() > 1e-4) return h.normalize();
        }
        return new THREE.Vector3(0, 0, 1);
      };

      // Car heading: the car's nose, held while dodging or pointing straight along up
      if (this.carHeading) this.carHeading = flatten(this.carHeading, up);
      if (!this.carHeading || this.carHeading.lengthSq() < 1e-6) this.carHeading = seed();
      this.carHeading.normalize();
      const carDesired = flatten(carFwd, up);
      if (carDesired.lengthSq() > 0.09 && !opts.flipping) turnToward(this.carHeading, carDesired.normalize(), up, ease(14, dt));

      // Ball heading: locked onto the ball, eased only when the ball is nearly overhead
      const toBallFlat = flatten(ballPos.clone().sub(this.pivot), up);
      const flatDist = toBallFlat.length();
      if (this.ballHeading) this.ballHeading = flatten(this.ballHeading, up);
      if (!this.ballHeading || this.ballHeading.lengthSq() < 1e-6) this.ballHeading = flatDist > 1 ? toBallFlat.clone() : this.carHeading.clone();
      this.ballHeading.normalize();
      if (flatDist > 1) turnToward(this.ballHeading, toBallFlat.divideScalar(flatDist), up, ease(24 * Math.min(1, flatDist / 250), dt));

      const heading = turnToward(this.carHeading.clone(), this.ballHeading, up, this.blend);

      // Swivel
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
        this.swivelPitch = Math.max(-0.6, Math.min(0.6, this.swivelPitch - input.mouseDY * 0.0004 * s.swivelSpeed * invert));
        this.mouseIdle = 0;
      } else {
        this.mouseIdle += dt;
        if (this.mouseIdle > 0.2) {
          this.swivelYaw = angleLerp(this.swivelYaw, 0, follow);
          this.swivelPitch += -this.swivelPitch * follow;
        }
      }
      const flat = heading.clone().applyAxisAngle(up, -this.swivelYaw).normalize();

      // How much ball aiming applies: full in ball cam, faded out while looking around with the stick
      this.aimWeight += ((usingStick ? 0 : 1) - this.aimWeight) * ease(10, dt);
      const w = this.blend * this.aimWeight;
      const angle = THREE.MathUtils.degToRad(s.angle);

      // Position. Ball cam orbits the camera spot around the pivot by the ball's elevation: fully when
      // the ball is below (camera rises to look down on it), softened when it's above so the camera
      // keeps car-cam height until the ball is well above you.
      const origin = this.pivot.clone().add(up.clone().multiplyScalar(s.height));
      const aim = clamp(elevation(ballPos.clone().sub(origin), up), -1.25, 1.2);
      const K = 0.3;
      const orbitTarget = w * (aim > 0 ? aim - K * (1 - Math.exp(-aim / K)) : aim);
      if (this.orbit === null) this.orbit = orbitTarget;
      this.orbit += (orbitTarget - this.orbit) * ease(18, dt);
      const pos = origin.clone().sub(pitched(flat, up, angle + this.orbit).multiplyScalar(s.distance));
      pos.y = Math.max(pos.y, 30);

      // Look pitch: car cam uses the Angle setting; ball cam aims from the camera at the ball
      const lookAim = clamp(elevation(ballPos.clone().sub(pos), up), -1.4, 1.4);
      const targetPitch = clamp(angle + w * lookAim + this.swivelPitch, -1.5, 1.5);
      this.pitch += (targetPitch - this.pitch) * ease(18, dt);
      const fwd = pitched(flat, up, this.pitch);

      const look = pos.clone().add(fwd);
      if (shake) { pos.add(shake); look.add(shake); }
      this.camera.position.copy(pos);
      this.camera.up.copy(up);
      this.camera.lookAt(look);
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
      if (this.camera.fov !== 80) this.applyFov(80);
      this.camera.position.copy(p);
      this.camera.up.copy(WORLD_UP);
      this.up.copy(WORLD_UP);
      this.camera.lookAt(l);
    }
  }

  return { ChaseCamera };
})();
