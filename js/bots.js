// Opponent bots.
//  - Element: port of the RLBotPack "Element" bot by Rangler (RLGym-trained neural network, 1v1).
//    Same observation (obs.py CustomObs), network (agent.py Actor, argmax actions), 8-tick action
//    repeat with the same update timing as bot.py, and the scripted speedflip kickoff
//    (sequences/speedflip.py). Weights converted from model.p into assets/bots/element.json.
//  - Rookie: a simple hand-written ball chaser for a gentler opponent.
// Bots see the world through the same RocketSim state the player uses.
window.Game = window.Game || {};

Game.Bots = (function () {
  const BT = Game.RL.BT_TO_UU;
  const POS_STD = 2300, ANG_STD = Math.PI;

  // ---------------- network ----------------
  let weights = null, weightsPromise = null;

  function decode(entry) {
    const bin = atob(entry.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { shape: entry.shape, data: new Float32Array(bytes.buffer) };
  }

  function loadElement() {
    if (weights) return Promise.resolve(weights);
    if (!weightsPromise) {
      weightsPromise = fetch('assets/bots/element.json')
        .then(r => { if (!r.ok) throw new Error('element.json ' + r.status); return r.json(); })
        .then(json => {
          weights = {};
          Object.keys(json).forEach(k => { weights[k] = decode(json[k]); });
          return weights;
        });
    }
    return weightsPromise;
  }

  function dense(x, name, relu) {
    const W = weights[name + '.weight'], b = weights[name + '.bias'];
    const [out, inp] = W.shape;
    const y = new Float32Array(out);
    for (let o = 0; o < out; o++) {
      let s = b.data[o];
      const row = o * inp;
      for (let i = 0; i < inp; i++) s += W.data[row + i] * x[i];
      y[o] = relu && s < 0 ? 0 : s;
    }
    return y;
  }

  // Actor.forward + argmax, then the +[-1,-1,-1,-1,-1,0,0,0] shift from bot.py
  function act(obs) {
    let x = dense(obs, 'fc1', true);
    x = dense(x, 'fc2', true);
    x = dense(x, 'fc3', true);
    x = dense(x, 'fc4', true);
    x = dense(x, 'fc5', true);
    const cat = dense(x, 'cat_heads', false);
    const ber = dense(x, 'ber_heads', false);
    const action = new Array(8);
    for (let i = 0; i < 5; i++) {
      let best = 0;
      for (let k = 1; k < 3; k++) if (cat[i * 3 + k] > cat[i * 3 + best]) best = k;
      action[i] = best - 1;
    }
    for (let i = 0; i < 3; i++) action[5 + i] = ber[i * 2 + 1] > ber[i * 2] ? 1 : 0;
    return action;
  }

  // ---------------- state views (RLGym PhysicsObject equivalents, uu) ----------------
  function carView(car, inverted) {
    const b = car.body, r = b.rot;
    const s = inverted ? [-1, -1, 1] : [1, 1, 1];
    const v3 = (v, k) => [v.x * k * s[0], v.y * k * s[1], v.z * k * s[2]];
    const f = r.col(0), u = r.col(2);
    return {
      position: v3(b.pos, BT),
      linear_velocity: v3(b.linVel, BT),
      angular_velocity: v3(b.angVel, 1),
      forward: [f.x * s[0], f.y * s[1], f.z],
      up: [u.x * s[0], u.y * s[1], u.z]
    };
  }

  function ballView(ball, inverted) {
    const s = inverted ? [-1, -1, 1] : [1, 1, 1];
    const v3 = (v, k) => [v.x * k * s[0], v.y * k * s[1], v.z * k * s[2]];
    return { position: v3(ball.pos, BT), linear_velocity: v3(ball.linVel, BT), angular_velocity: v3(ball.angVel, 1) };
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const div = (a, k) => [a[0] / k, a[1] / k, a[2] / k];
  const norm = a => Math.hypot(a[0], a[1], a[2]);

  // RLBot boost pad order: sorted by y, then x. The inverted list is simply reversed.
  let padOrder = null;
  function padStates(world, inverted) {
    if (!padOrder) {
      padOrder = world.boostPads.map((p, i) => i).sort((a, b) => {
        const pa = world.boostPads[a].pos, pb = world.boostPads[b].pos;
        return pa.y - pb.y || pa.x - pb.x;
      });
    }
    const vals = padOrder.map(i => (world.boostPads[i].isActive === false ? 0 : 1));
    return inverted ? vals.reverse() : vals;
  }

  // ---------------- Element ----------------
  class ElementBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Element';
      this.tickSkip = 8;
      this.reset();
    }

    reset() {
      this.ticks = this.tickSkip;
      this.updateAction = true;
      this.action = [0, 0, 0, 0, 0, 0, 0, 0];
      this.controls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      this.kickoffSeq = null;
      this.offGroundTicks = [0, 0];
    }

    get ready() { return !!weights; }

    // PlayerData fields for a car
    player(car, i) {
      const inverted = this.world.cars[this.index].team === 'orange';
      const s = car.state;
      return {
        team: car.team,
        car: carView(car, inverted),
        boost_amount: s.boost / 100,
        on_ground: s.isOnGround || this.offGroundTicks[i] <= 6,
        has_flip: !(s.hasDoubleJumped || s.hasFlipped),
        is_demoed: !!car.isDemoed
      };
    }

    addPlayer(obs, p, ball) {
      obs.push(
        ...div(sub(ball.position, p.car.position), POS_STD),
        ...div(sub(ball.linear_velocity, p.car.linear_velocity), POS_STD),
        ...div(p.car.position, POS_STD),
        ...p.car.forward,
        ...p.car.up,
        ...div(p.car.linear_velocity, POS_STD),
        ...div(p.car.angular_velocity, ANG_STD),
        p.boost_amount, p.on_ground ? 1 : 0, p.has_flip ? 1 : 0, p.is_demoed ? 1 : 0
      );
    }

    buildObs(me, opp, inverted) {
      const ball = ballView(this.world.ball, inverted);
      const obs = [
        ...div(ball.position, POS_STD),
        ...div(ball.linear_velocity, POS_STD),
        ...div(ball.angular_velocity, ANG_STD),
        ...this.action,
        ...padStates(this.world, inverted)
      ];
      this.addPlayer(obs, me, ball);
      this.addPlayer(obs, opp, ball);
      obs.push(...div(sub(opp.car.position, me.car.position), POS_STD), ...div(sub(opp.car.linear_velocity, me.car.linear_velocity), POS_STD));
      return obs;
    }

    updateControls(a) {
      const c = this.controls;
      c.throttle = a[0];
      c.steer = a[1];
      c.pitch = a[2];
      c.yaw = a[5] > 0 ? 0 : a[3];
      c.roll = a[4];
      c.jump = a[5] > 0;
      c.boost = a[6] > 0;
      c.handbrake = a[7] > 0;
    }

    // Called once per physics tick (120 Hz) before the world steps
    tick() {
      const w = this.world;
      w.cars.forEach((car, i) => { this.offGroundTicks[i] = car.state.isOnGround ? 0 : this.offGroundTicks[i] + 1; });
      this.ticks += 1;
      if (!weights) return this.controls;

      const meCar = w.cars[this.index];
      const oppIndex = w.cars.findIndex((c, i) => i !== this.index);
      const me = this.player(meCar, this.index);
      const opp = this.player(w.cars[oppIndex], oppIndex);
      const inverted = meCar.team === 'orange';

      if (w.kickoffPause) {
        if (!this.kickoffSeq) this.kickoffSeq = new Speedflip(me);
        if (this.kickoffSeq.isValid(me, ballView(w.ball, inverted))) {
          this.action = this.kickoffSeq.getAction(me);
          this.updateControls(this.action);
          return this.controls;
        }
      } else {
        this.kickoffSeq = null;
      }

      if (this.updateAction) {
        this.updateAction = false;
        this.action = act(this.buildObs(me, opp, inverted));
      }
      if (this.ticks >= this.tickSkip - 1) this.updateControls(this.action);
      if (this.ticks >= this.tickSkip) {
        this.ticks = 0;
        this.updateAction = true;
      }
      return this.controls;
    }
  }

  // sequences/speedflip.py
  class Speedflip {
    constructor(player) {
      this.state = 'align';
      this.initial = player.car;
      const x = player.car.position[0];
      this.direction = x > 0 ? 1 : -1;
      this.initialAngle = Math.PI / 16;
      this.validDistance = 600;
      if (Math.abs(x) < 25) {
        this.yawStrength = 1;
        this.driveDistance = 290;
        this.initialAngle = Math.PI / 22;
      } else if (Math.abs(x) < 500) {
        this.yawStrength = 0.6;
        this.driveDistance = 330;
        this.direction = -this.direction;
      } else {
        this.yawStrength = 0.4;
        this.driveDistance = 240;
      }
    }

    isValid(player, ball) {
      return this.state !== 'done' && norm(sub(ball.position, player.car.position)) > this.validDistance;
    }

    getAction(player) {
      const car = player.car, init = this.initial;
      if (this.state === 'align') {
        const d = car.forward[0] * init.forward[0] + car.forward[1] * init.forward[1] + car.forward[2] * init.forward[2];
        if (Math.acos(Math.max(-1, Math.min(1, d))) < this.initialAngle) return [1, -this.direction, 0, 0, 0, 0, 1, 0];
        this.state = 'drive';
      }
      if (this.state === 'drive') {
        if (norm(sub(car.position, init.position)) < this.driveDistance) return [1, 0, 0, 0, 0, 0, 1, 0];
        this.state = 'first_jump';
      }
      if (this.state === 'first_jump') {
        this.state = 'start_flip';
        return [1, 0, 0, 0, 0, 1, 1, 0];
      }
      if (this.state === 'start_flip') {
        if (player.on_ground) return [1, 0, 0, 0, this.direction, 0, 1, 0];
        this.state = 'cancel_flip';
        return [1, 0, -1, 0, this.direction, 1, 1, 0];
      }
      if (this.state === 'cancel_flip') {
        const boost = norm(car.linear_velocity) < 2295 ? 1 : 0;
        if (!player.on_ground) return [1, 0, 1, this.yawStrength * this.direction, this.direction, 0, boost, 0];
        this.state = 'done';
        return [1, 0, 0, 0, 0, 0, 1, 0];
      }
      return [0, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  // ---------------- Rookie ----------------
  class RookieBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Rookie';
      this.controls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      this.jumpTimer = 0;
    }
    get ready() { return true; }
    reset() { this.jumpTimer = 0; }
    tick() {
      const w = this.world, car = w.cars[this.index], b = car.body, c = this.controls;
      const own = car.team === 'orange' ? 1 : -1; // y of own goal
      const ball = w.ball.pos.mul(BT), pos = b.pos.mul(BT);
      // aim slightly behind the ball, on the line from the opponent's goal
      const target = { x: ball.x * 0.9, y: ball.y + own * 140 };
      const dx = target.x - pos.x, dy = target.y - pos.y;
      const f = b.rot.col(0), r = b.rot.col(1);
      const fl = Math.hypot(f.x, f.y) || 1;
      const fwdDot = (dx * f.x + dy * f.y) / (Math.hypot(dx, dy) * fl || 1);
      const side = dx * r.x + dy * r.y;
      c.throttle = 1;
      c.steer = Math.max(-1, Math.min(1, side * 0.01));
      c.handbrake = fwdDot < 0.2 && car.state.isOnGround && Math.hypot(dx, dy) < 1500;
      c.boost = fwdDot > 0.9 && car.state.isOnGround;
      const dist = Math.hypot(ball.x - pos.x, ball.y - pos.y);
      this.jumpTimer = Math.max(0, this.jumpTimer - 1);
      c.jump = false;
      if (dist < 260 && ball.z > 170 && ball.z < 420 && car.state.isOnGround && this.jumpTimer === 0) { c.jump = true; this.jumpTimer = 50; }
      c.pitch = 0; c.yaw = c.steer; c.roll = 0;
      return c;
    }
  }

  const OPPONENTS = [
    { id: 'element', name: 'Element', desc: 'Neural network trained with RLGym (RLBotPack, by Rangler). Plays 1v1 like a strong player.', make: (w, i) => new ElementBot(w, i), load: loadElement },
    { id: 'rookie', name: 'Rookie', desc: 'Simple ball chaser. Good for warming up.', make: (w, i) => new RookieBot(w, i), load: () => Promise.resolve() }
  ];

  return { OPPONENTS, loadElement, ElementBot, RookieBot };
})();
