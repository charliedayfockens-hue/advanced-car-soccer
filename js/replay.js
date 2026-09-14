// Records the last few seconds of every tick (all cars, wheels, boost state, ball) so a goal can be
// replayed. Frames are stored in sim units; sample() brackets a time for interpolation.
window.Game = window.Game || {};

Game.Replay = (function () {
  const BT = Game.RL.BT_TO_UU;

  class Recorder {
    constructor(seconds) {
      this.maxFrames = Math.ceil(seconds * Game.RL.TICK_RATE);
      this.frames = [];
    }

    clear() { this.frames.length = 0; }

    record(world, time, ballHidden) {
      const ball = world.ball;
      this.frames.push({
        t: time,
        ballPos: ball.pos.clone(),
        ballQuat: ball.rot.toQuat(),
        ballHidden: !!ballHidden,
        cars: world.cars.map(car => {
          const b = car.body, s = car.state;
          return {
            pos: b.pos.clone(),
            quat: b.rot.toQuat(),
            fwdSpeed: b.linVel.dot(b.rot.col(0)) * BT,
            speed: b.linVel.length() * BT,
            boosting: s.isBoosting,
            supersonic: s.isSupersonic,
            demoed: !!car.isDemoed,
            wheels: car.wheels.map(w => [w.suspensionLength, w.steerAngle])
          };
        })
      });
      if (this.frames.length > this.maxFrames) this.frames.shift();
    }

    get startTime() { return this.frames.length ? this.frames[0].t : 0; }
    get endTime() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }

    // Returns { a, b, alpha } bracketing time t
    sample(t) {
      const f = this.frames;
      if (!f.length) return null;
      if (t <= f[0].t) return { a: f[0], b: f[0], alpha: 0 };
      if (t >= f[f.length - 1].t) return { a: f[f.length - 1], b: f[f.length - 1], alpha: 0 };
      let lo = 0, hi = f.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (f[mid].t <= t) lo = mid; else hi = mid;
      }
      const a = f[lo], b = f[hi];
      return { a, b, alpha: (t - a.t) / Math.max(b.t - a.t, 1e-6) };
    }

    // Snapshot part of the buffer so recording can keep going while a replay plays
    freeze(fromTime, toTime) {
      const r = new Recorder(0);
      r.frames = this.frames.filter(fr => fr.t >= fromTime && fr.t <= toTime);
      return r;
    }
  }

  return { Recorder };
})();
