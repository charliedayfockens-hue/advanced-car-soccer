// Low-level controllers shared by the scripted bots (Opti's recovery and demo sub-models, Botimus and Bumblebee).
// Axes are the simulation's (RocketSim, BT): rot.col(0) forward, col(1) the side steering turns toward, col(2) up.
// Measured control signs: pitch +1 spins about -col(1), yaw +1 about +col(2), roll +1 about -col(0).
window.Game = window.Game || {};

Game.BotControl = (function () {
  const { Vec3 } = Game.Math;
  const BT = Game.RL.BT_TO_UU;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clamp11 = v => clamp(v, -1, 1);

  // Point the nose along `forward` and the roof along `up` (world vectors) with a PD controller on the car's
  // angular velocity; writes pitch, yaw and roll into `controls`
  function reorient(car, forward, up, controls, gain) {
    const R = car.body.rot, f = R.col(0), r = R.col(1), u = R.col(2), av = car.body.angVel;
    const F = forward.normalized(), Uw = up.normalized();
    let e = f.cross(F).add(u.cross(Uw).mul(0.7));
    if (f.dot(F) < -0.95) e = e.add(u); // nose pointing straight away: start with a yaw
    const k = gain || 5;
    const dF = k * e.dot(f) - av.dot(f), dR = k * e.dot(r) - av.dot(r), dU = k * e.dot(u) - av.dot(u);
    controls.roll = clamp11(-dF);
    controls.pitch = clamp11(-dR);
    controls.yaw = clamp11(dU);
    return F.dot(f);
  }

  // Land wheels-down: nose along the horizontal velocity, roof up; flips over when stuck on the roof
  function recover(car, controls) {
    const v = car.body.linVel;
    let fwd = new Vec3(v.x, v.y, 0);
    if (fwd.length2() < 1e-4) { const f = car.body.rot.col(0); fwd = new Vec3(f.x, f.y, 0); }
    if (fwd.length2() < 1e-6) fwd = new Vec3(1, 0, 0);
    reorient(car, fwd, new Vec3(0, 0, 1), controls, 4);
    controls.throttle = 1;
    controls.boost = false;
    controls.handbrake = false;
    controls.jump = car.state.isOnGround && car.body.rot.col(2).z < -0.9;
  }

  // Drive toward a world point in uu (x, y); returns the facing dot
  function steerTo(car, tx, ty, controls, opts) {
    opts = opts || {};
    const b = car.body, px = b.pos.x * BT, py = b.pos.y * BT, dx = tx - px, dy = ty - py;
    const dist = Math.hypot(dx, dy) || 1, f = b.rot.col(0), r = b.rot.col(1);
    const facing = (dx * f.x + dy * f.y) / (dist * (Math.hypot(f.x, f.y) || 1));
    const side = (dx * r.x + dy * r.y) / dist;
    controls.throttle = 1;
    controls.steer = clamp11((facing < 0 ? Math.sign(side || 1) : side) * (opts.steerGain || 4));
    controls.yaw = controls.steer; controls.pitch = 0; controls.roll = 0;
    controls.handbrake = car.state.isOnGround && facing < -0.1 && dist > 500;
    controls.boost = !!opts.boost && (car.state.isOnGround ? facing > 0.7 : facing > 0.9);
    controls.jump = false;
    return facing;
  }

  return { reorient, recover, steerTo, clamp, clamp11 };
})();
