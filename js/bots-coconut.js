// Indonesian Coconut: port of SentientPlatypus's RLGym v2 bot (https://github.com/SentientPlatypus/indonesian_coconut).
//  - Policy: rlgym-ppo DiscreteFF 92 -> 2048 -> 2048 -> 1024 -> 1024 -> 90, from data/checkpoints/V3/17.9B
//    (PPO_POLICY.pt converted to float16 in assets/bots/coconut.bin; argmax matches the float32 network)
//  - Observations: rlgym DefaultObs with freestyler.py's coefficients; actions: LookupTableAction, repeated 8 ticks
//  - The network runs in js/nn-worker.js so it never stalls a frame
// The repository has no license: the network belongs to its author and is credited in assets/bots/BOT_CREDITS.txt.
window.Game = window.Game || {};

Game.BotsCoconut = (function () {
  const BT = Game.RL.BT_TO_UU, TICK_SKIP = 8, URL = 'assets/bots/coconut.bin';
  const POS = [1 / 4096, 1 / 6000, 1 / 2044], LIN = 1 / 2300, ANG = 1 / 5.5, PAD = 1 / 10;
  const ACTIONS = Game.BotsNecto.NEXTO_ACTIONS; // same 90-entry LookupTableAction table

  // Runs the policy in a worker, or on the main thread if workers aren't available
  class Runner {
    constructor(buffer) {
      this.pending = new Map();
      this.nextId = 1;
      this.buffer = buffer;
      try {
        this.worker = new Worker('js/nn-worker.js?v=' + Game.Assets.VERSION);
        this.worker.onmessage = e => {
          const m = e.data;
          if (m.type === 'error') { console.warn('Coconut worker:', m.message); this.fallback(); return; }
          if (m.type !== 'action') return;
          const cb = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (cb) cb(m.action);
        };
        this.worker.onerror = () => this.fallback();
        this.worker.postMessage({ type: 'init', buffer: buffer.slice(0) });
      } catch (e) {
        this.fallback();
      }
    }

    fallback() {
      if (this.worker) this.worker.terminate();
      this.worker = null;
      if (!this.net) this.net = Game.PolicyNet.parse(this.buffer);
      const waiting = [...this.pending.values()];
      this.pending.clear();
      waiting.forEach(cb => cb(null));
    }

    act(obs, cb) {
      if (this.worker) {
        const id = this.nextId++;
        this.pending.set(id, cb);
        this.worker.postMessage({ type: 'act', id, obs }, [obs.buffer]);
      } else {
        cb(Game.PolicyNet.forward(this.net, obs));
      }
    }
  }

  let runner = null, promise = null;
  function load() {
    if (runner) return Promise.resolve(runner);
    if (!promise) {
      promise = Game.Assets.fetchChecked(URL, { kind: 'bot weights', check: b => b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x42 && b[3] === 0x57 })
        .then(buf => {
          try { Game.PolicyNet.parse(buf); } catch (e) { throw new Game.Assets.AssetError(URL, 'has corrupt network weights - it was damaged on upload'); }
          runner = new Runner(buf);
          return runner;
        })
        .catch(err => { promise = null; Game.Assets.report(err, URL); throw err; });
    }
    return promise;
  }

  class CoconutBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Indonesian Coconut';
      this.reset();
    }

    get ready() { return !!runner; }

    reset() {
      this.ticks = TICK_SKIP;
      this.waiting = false;
      this.generation = (this.generation || 0) + 1;
      this.controls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
    }

    // DefaultObs._generate_car_obs (20 values)
    carObs(o, k, car, inv) {
      const b = car.body, f = b.rot.col(0), u = b.rot.col(2), s = car.state, m = inv ? -1 : 1;
      o.set([
        b.pos.x * BT * m * POS[0], b.pos.y * BT * m * POS[1], b.pos.z * BT * POS[2],
        f.x * m, f.y * m, f.z, u.x * m, u.y * m, u.z,
        b.linVel.x * BT * m * LIN, b.linVel.y * BT * m * LIN, b.linVel.z * BT * LIN,
        b.angVel.x * m * ANG, b.angVel.y * m * ANG, b.angVel.z * ANG,
        s.boost / 100, car.isDemoed ? Math.max(car.demoTimer, 0) : 0, s.isOnGround ? 1 : 0, s.isBoosting ? 1 : 0, s.isSupersonic ? 1 : 0
      ], k);
      return k + 20;
    }

    // DefaultObs._build_obs for this bot's car (orange sees the field inverted)
    buildObs() {
      const w = this.world, me = w.cars[this.index], inv = me.team === 'orange', m = inv ? -1 : 1, s = me.state;
      const o = new Float32Array(52 + 20 * w.cars.length), ball = w.ball;
      o.set([
        ball.pos.x * BT * m * POS[0], ball.pos.y * BT * m * POS[1], ball.pos.z * BT * POS[2],
        ball.linVel.x * BT * m * LIN, ball.linVel.y * BT * m * LIN, ball.linVel.z * BT * LIN,
        ball.angVel.x * m * ANG, ball.angVel.y * m * ANG, ball.angVel.z * ANG
      ], 0);
      const pads = w.boostPads;
      if (!this.padOrder) this.padOrder = pads.map((p, i) => i).sort((a, b) => pads[a].pos.y - pads[b].pos.y || pads[a].pos.x - pads[b].pos.x);
      const timers = this.padOrder.map(i => (w.boostMode === 'standard' ? pads[i].cooldown || 0 : 0) * PAD);
      o.set(inv ? timers.reverse() : timers, 9);
      const holdingJump = !!(me.controls && me.controls.jump);
      const hasFlip = !s.hasDoubleJumped && !s.hasFlipped && s.airTimeSinceJump < Game.RL.DOUBLEJUMP_MAX_DELAY;
      o.set([
        holdingJump ? 1 : 0, s.handbrakeVal, s.hasJumped ? 1 : 0, s.isJumping ? 1 : 0, s.hasFlipped ? 1 : 0,
        s.hasFlipped && s.flipTime < 0.65 ? 1 : 0, s.hasDoubleJumped ? 1 : 0,
        !s.isOnGround && !holdingJump && hasFlip ? 1 : 0, s.airTimeSinceJump
      ], 43);
      let k = this.carObs(o, 52, me, inv);
      w.cars.forEach(c => { if (c !== me && c.team === me.team) k = this.carObs(o, k, c, inv); });
      w.cars.forEach(c => { if (c.team !== me.team) k = this.carObs(o, k, c, inv); });
      return o;
    }

    apply(a) {
      const c = this.controls;
      c.throttle = a[0]; c.steer = a[1]; c.pitch = a[2]; c.yaw = a[3]; c.roll = a[4];
      c.jump = a[5] > 0; c.boost = a[6] > 0; c.handbrake = a[7] > 0;
    }

    // RepeatAction(LookupTableAction(), 8): a new decision every 8 ticks
    tick() {
      if (!runner) return this.controls;
      if (this.ticks >= TICK_SKIP && !this.waiting) {
        this.ticks = 0;
        this.waiting = true;
        const gen = this.generation;
        runner.act(this.buildObs(), index => {
          if (gen !== this.generation) return;
          this.waiting = false;
          if (index !== null && ACTIONS[index]) this.apply(ACTIONS[index]);
        });
      }
      this.ticks += 1;
      return this.controls;
    }
  }

  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'nexto') + 1, 0,
    { id: 'coconut', name: 'Indonesian Coconut', desc: 'Supersonic Legend-level challenger, 1v1 only. An RLGym v2 reinforcement learning bot by SentientPlatypus, trained for 17.9 billion steps. Air dribbles, flip resets, flicks and wall play, and it beat Element 47-3 in testing.',
      modes: ['1v1'], make: (w, i) => new CoconutBot(w, i), load });

  return { CoconutBot, load, Runner };
})();
