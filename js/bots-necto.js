// Necto and Nexto: ports of the RLGym community bots by Rolv, Soren and several contributors
// (https://github.com/Rolv-Arild/Necto, distributed in RLBotPack).
//  - Weights converted from necto-model.pt / nexto-model.pt into assets/bots/necto.json and nexto.json
//  - Networks: EARLPerceiver attention models exactly as in the TorchScript code (Necto: one block;
//    Nexto: two pre-norm blocks and a dot-product action head over its 90-action table)
//  - Observations: necto_obs.py / nexto_obs.py, with game state decoded like rlgym-compat 1.0.2
//  - Actions, 8-tick action repeat and the hardcoded speed-flip kickoff: agent.py / bot.py
// This file and those weight files are adapted material under CC BY-NC-SA 4.0 (non-commercial use only),
// see assets/bots/NECTO_NEXTO_LICENSE.txt.
window.Game = window.Game || {};

Game.BotsNecto = (function () {
  const BT = Game.RL.BT_TO_UU;
  const TICK_SKIP = 8;
  const EMBED = 128, HEADS = 4;

  // necto_obs.py / nexto_obs.py BOOST_LOCATIONS, in RLBot pad order (by y, then x)
  const BOOST_LOCATIONS = [
    [0, -4240, 70], [-1792, -4184, 70], [1792, -4184, 70], [-3072, -4096, 73], [3072, -4096, 73],
    [-940, -3308, 70], [940, -3308, 70], [0, -2816, 70], [-3584, -2484, 70], [3584, -2484, 70],
    [-1788, -2300, 70], [1788, -2300, 70], [-2048, -1036, 70], [0, -1024, 70], [2048, -1036, 70],
    [-3584, 0, 73], [-1024, 0, 70], [1024, 0, 70], [3584, 0, 73], [-2048, 1036, 70], [0, 1024, 70],
    [2048, 1036, 70], [-1788, 2300, 70], [1788, 2300, 70], [-3584, 2484, 70], [3584, 2484, 70],
    [0, 2816, 70], [-940, 3310, 70], [940, 3308, 70], [-3072, 4096, 73], [3072, 4096, 73],
    [-1792, 4184, 70], [1792, 4184, 70], [0, 4240, 70]
  ];
  // _norm and _invert from the observation builders (24 features per entity)
  const NORM = [1, 1, 1, 1, 1, 2300, 2300, 2300, 2300, 2300, 2300, 1, 1, 1, 1, 1, 1, 5.5, 5.5, 5.5, 1, 1, 1, 1];
  const INVERT = [1, 1, 1, 1, 1, -1, -1, 1, -1, -1, 1, -1, -1, 1, -1, -1, 1, -1, -1, 1, 1, 1, 1, 1];

  // bot.py KICKOFF_CONTROLS, one entry per tick: [throttle, steer, pitch, yaw, roll, jump, boost, handbrake]
  const KICKOFF = [];
  [[11, [1, 0, 0, 0, 0, 0, 1, 0]], [4, [1, -1, 0, 0, 0, 0, 1, 0]], [2, [1, 0, 0, 0, 0, 1, 1, 0]], [1, [1, 0, 0, 0, 0, 0, 1, 0]],
    [1, [1, 0, -0.7, 0.8, 0, 1, 1, 0]], [13, [1, 0, 1, 0, 0, 0, 1, 0]], [10, [1, 0, 0.5, 0, 1, 0, 0, 0]]]
    .forEach(([n, a]) => { for (let i = 0; i < n * 4; i++) KICKOFF.push(a); });

  // Nexto agent.py make_lookup_table
  const NEXTO_ACTIONS = (() => {
    const actions = [];
    for (const throttle of [-1, 0, 1]) for (const steer of [-1, 0, 1]) for (const boost of [0, 1]) for (const handbrake of [0, 1]) {
      if (boost === 1 && throttle !== 1) continue;
      actions.push([throttle || boost, steer, 0, steer, 0, 0, boost, handbrake]);
    }
    for (const pitch of [-1, 0, 1]) for (const yaw of [-1, 0, 1]) for (const roll of [-1, 0, 1]) for (const jump of [0, 1]) for (const boost of [0, 1]) {
      if (jump === 1 && yaw !== 0) continue;
      if (pitch === 0 && roll === 0 && jump === 0) continue;
      const handbrake = jump === 1 && (pitch !== 0 || yaw !== 0 || roll !== 0) ? 1 : 0;
      actions.push([boost, yaw, pitch, yaw, roll, jump, boost, handbrake]);
    }
    return actions;
  })();

  // ---------------- weights ----------------
  const REQUIRED = {
    necto: ['earl.query_preprocess.0.weight', 'earl.key_value_preprocess.2.bias', 'earl.blocks.0.attention.in_proj_weight', 'earl.blocks.0.attention.out_proj.weight', 'earl.blocks.0.linear2.weight', 'output.linear.weight'],
    nexto: ['earl.query_preprocess.0.weight', 'earl.blocks.1.attention.in_proj_weight', 'earl.blocks.1.norm3.weight', 'output.net.4.weight', 'output.emb_convertor.weight', 'c2']
  };
  const models = {};

  function decode(entry) {
    const bin = atob(entry.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { shape: entry.shape, data: new Float32Array(bytes.buffer) };
  }

  function loadModel(id) {
    const m = models[id] || (models[id] = {});
    if (m.weights) return Promise.resolve(m.weights);
    if (!m.promise) {
      const url = 'assets/bots/' + id + '.json';
      m.promise = Game.Assets.json(url).then(json => {
        const w = {};
        try {
          Object.keys(json).forEach(k => { if (k !== '__constants__') w[k] = decode(json[k]); });
        } catch (e) {
          throw new Game.Assets.AssetError(url, 'has corrupt network weights - it was damaged on upload');
        }
        const missing = REQUIRED[id].find(k => !w[k]);
        if (missing) throw new Game.Assets.AssetError(url, 'is missing ' + missing + ' - it is incomplete or outdated');
        m.weights = w;
        return w;
      }).catch(err => {
        m.promise = null;
        Game.Assets.report(err, url);
        throw err;
      });
    }
    return m.promise;
  }

  // ---------------- tensor math (row-major Float32Arrays) ----------------
  // rows x inDim -> rows x outDim, using rows [row0, row0 + outDim) of W and b (for chunked in_proj)
  function linear(X, rows, W, b, row0, outDim) {
    const inDim = W.shape[1];
    row0 = row0 || 0;
    outDim = outDim || W.shape[0];
    const Y = new Float32Array(rows * outDim);
    for (let r = 0; r < rows; r++) {
      const xo = r * inDim;
      for (let o = 0; o < outDim; o++) {
        const wo = (row0 + o) * inDim;
        let s = b.data[row0 + o];
        for (let i = 0; i < inDim; i++) s += W.data[wo + i] * X[xo + i];
        Y[r * outDim + o] = s;
      }
    }
    return Y;
  }

  function relu(X) { for (let i = 0; i < X.length; i++) if (X[i] < 0) X[i] = 0; return X; }
  function addInPlace(A, B) { for (let i = 0; i < A.length; i++) A[i] += B[i]; return A; }

  // torch.layer_norm(x, [dim], weight, bias), eps 1e-5
  function layerNorm(X, rows, w, b) {
    const dim = w.shape[0], Y = new Float32Array(X.length);
    for (let r = 0; r < rows; r++) {
      const o = r * dim;
      let mean = 0, varSum = 0;
      for (let i = 0; i < dim; i++) mean += X[o + i];
      mean /= dim;
      for (let i = 0; i < dim; i++) { const d = X[o + i] - mean; varSum += d * d; }
      const inv = 1 / Math.sqrt(varSum / dim + 1e-5);
      for (let i = 0; i < dim; i++) Y[o + i] = (X[o + i] - mean) * inv * w.data[i] + b.data[i];
    }
    return Y;
  }

  // Sequential(Linear, ReLU, Linear, ReLU)
  function preprocess(w, prefix, X, rows) {
    const h = relu(linear(X, rows, w[prefix + '.0.weight'], w[prefix + '.0.bias']));
    return relu(linear(h, rows, w[prefix + '.2.weight'], w[prefix + '.2.bias']));
  }

  // nn.MultiheadAttention (4 heads, key padding mask of zeros) returning the projected output
  function attention(w, prefix, Q, nq, KV, nk) {
    const Wi = w[prefix + '.in_proj_weight'], bi = w[prefix + '.in_proj_bias'];
    const q = linear(Q, nq, Wi, bi, 0, EMBED);
    const k = linear(KV, nk, Wi, bi, EMBED, EMBED);
    const v = linear(KV, nk, Wi, bi, 2 * EMBED, EMBED);
    const hd = EMBED / HEADS, scale = 1 / Math.sqrt(hd);
    const out = new Float32Array(nq * EMBED), logits = new Float64Array(nk);
    for (let h = 0; h < HEADS; h++) {
      const ho = h * hd;
      for (let i = 0; i < nq; i++) {
        let max = -Infinity;
        for (let j = 0; j < nk; j++) {
          let s = 0;
          for (let d = 0; d < hd; d++) s += q[i * EMBED + ho + d] * k[j * EMBED + ho + d];
          logits[j] = s * scale;
          if (logits[j] > max) max = logits[j];
        }
        let sum = 0;
        for (let j = 0; j < nk; j++) { logits[j] = Math.exp(logits[j] - max); sum += logits[j]; }
        for (let j = 0; j < nk; j++) {
          const a = logits[j] / sum;
          for (let d = 0; d < hd; d++) out[i * EMBED + ho + d] += a * v[j * EMBED + ho + d];
        }
      }
    }
    return linear(out, nq, w[prefix + '.out_proj.weight'], w[prefix + '.out_proj.bias']);
  }

  // Necto: EARLPerceiver with one post-residual block, ReLU, ControlsPredictorDiscrete -> 12 logits
  function nectoForward(w, q, kv, nk) {
    const Q = preprocess(w, 'earl.query_preprocess', q, 1);
    const KV = preprocess(w, 'earl.key_value_preprocess', kv, nk);
    const x = addInPlace(Q, attention(w, 'earl.blocks.0.attention', Q, 1, KV, nk));
    const hidden = relu(linear(x, 1, w['earl.blocks.0.linear1.weight'], w['earl.blocks.0.linear1.bias']));
    addInPlace(x, linear(hidden, 1, w['earl.blocks.0.linear2.weight'], w['earl.blocks.0.linear2.bias']));
    return linear(relu(x), 1, w['output.linear.weight'], w['output.linear.bias']);
  }

  // Nexto: two pre-norm blocks, ReLU, ControlsPredictorDot over the 90-action table -> 90 logits
  function nextoForward(w, q, kv, nk) {
    const Q = preprocess(w, 'earl.query_preprocess', q, 1);
    const KV = preprocess(w, 'earl.key_value_preprocess', kv, nk);
    let x = Q;
    for (const p of ['earl.blocks.0', 'earl.blocks.1']) {
      const att = attention(w, p + '.attention', layerNorm(x, 1, w[p + '.norm1.weight'], w[p + '.norm1.bias']), 1,
        layerNorm(KV, nk, w[p + '.norm2.weight'], w[p + '.norm2.bias']), nk);
      x = addInPlace(x, att);
      const hidden = relu(linear(layerNorm(x, 1, w[p + '.norm3.weight'], w[p + '.norm3.bias']), 1, w[p + '.linear1.weight'], w[p + '.linear1.bias']));
      addInPlace(x, linear(hidden, 1, w[p + '.linear2.weight'], w[p + '.linear2.bias']));
    }
    const playerEmb = linear(relu(x), 1, w['output.emb_convertor.weight'], w['output.emb_convertor.bias']);
    if (!models.nexto.actionEmb) {
      let a = relu(linear(w.c2.data, 90, w['output.net.0.weight'], w['output.net.0.bias']));
      a = relu(linear(a, 90, w['output.net.2.weight'], w['output.net.2.bias']));
      models.nexto.actionEmb = relu(linear(a, 90, w['output.net.4.weight'], w['output.net.4.bias']));
    }
    const actionEmb = models.nexto.actionEmb, dim = playerEmb.length;
    const logits = new Float32Array(90);
    for (let a = 0; a < 90; a++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += actionEmb[a * dim + d] * playerEmb[d];
      logits[a] = s;
    }
    return logits;
  }

  function argmax(arr, start, len) {
    let best = 0;
    for (let i = 1; i < len; i++) if (arr[start + i] > arr[start + best]) best = i;
    return best;
  }

  // ---------------- shared bot shell (bot.py) ----------------
  class RLGymBot {
    constructor(world, carIndex, name, modelId) {
      this.world = world;
      this.index = carIndex;
      this.name = name;
      this.modelId = modelId;
      this.reset();
    }

    get ready() { return !!(models[this.modelId] && models[this.modelId].weights); }
    get weights() { return models[this.modelId] && models[this.modelId].weights; }

    reset() {
      this.ticks = TICK_SKIP;
      this.updateAction = true;
      this.action = [0, 0, 0, 0, 0, 0, 0, 0];
      this.controls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      this.kickoffIndex = -1;
      this.groundTicks = new Map();
    }

    // rlgym-compat GameState.decode: ticks since wheel contact, per car
    trackGround() {
      for (const car of this.world.cars) this.groundTicks.set(car.id, car.state.isOnGround ? 0 : (this.groundTicks.get(car.id) || 0) + 1);
    }

    // PlayerData for [self] + teammates + opponents (uu)
    players() {
      const w = this.world, me = w.cars[this.index];
      const order = [me, ...w.cars.filter(c => c !== me && c.team === me.team), ...w.cars.filter(c => c.team !== me.team)];
      return order.map(car => {
        const b = car.body, f = b.rot.col(0), u = b.rot.col(2), s = car.state;
        return {
          id: car.id,
          team: car.team === 'orange' ? 1 : 0,
          pos: [b.pos.x * BT, b.pos.y * BT, b.pos.z * BT],
          vel: [b.linVel.x * BT, b.linVel.y * BT, b.linVel.z * BT],
          ang: [b.angVel.x, b.angVel.y, b.angVel.z],
          fwd: [f.x, f.y, f.z],
          up: [u.x, u.y, u.z],
          demoed: car.isDemoed ? 1 : 0,
          onGround: s.isOnGround || this.groundTicks.get(car.id) <= 6 ? 1 : 0,
          hasFlip: s.hasDoubleJumped || s.hasFlipped ? 0 : 1,
          boost: s.boost / 100
        };
      });
    }

    // GameState.boost_pads (is_active) in BOOST_LOCATIONS order
    padsActive() {
      const pads = this.world.boostPads;
      if (!this.padOrder) {
        this.padOrder = pads.map((p, i) => i).sort((a, b) => pads[a].pos.y - pads[b].pos.y || pads[a].pos.x - pads[b].pos.x);
      }
      return this.padOrder.map(i => (pads[i].isActive === false ? 0 : 1));
    }

    setPhysicsRow(row, i, p) {
      row[i + 5] = p.pos[0]; row[i + 6] = p.pos[1]; row[i + 7] = p.pos[2];
      row[i + 8] = p.vel[0]; row[i + 9] = p.vel[1]; row[i + 10] = p.vel[2];
      row[i + 17] = p.ang[0]; row[i + 18] = p.ang[1]; row[i + 19] = p.ang[2];
    }

    ballData() {
      const b = this.world.ball;
      return { pos: [b.pos.x * BT, b.pos.y * BT, b.pos.z * BT], vel: [b.linVel.x * BT, b.linVel.y * BT, b.linVel.z * BT], ang: [b.angVel.x, b.angVel.y, b.angVel.z] };
    }

    updateControls(a) {
      const c = this.controls;
      c.throttle = a[0]; c.steer = a[1]; c.pitch = a[2]; c.yaw = a[3]; c.roll = a[4];
      c.jump = a[5] > 0; c.boost = a[6] > 0; c.handbrake = a[7] > 0;
    }

    // bot.py maybe_do_kickoff
    maybeKickoff() {
      const w = this.world;
      if (!w.kickoffPause) { this.kickoffIndex = -1; return; }
      if (this.kickoffIndex >= 0) {
        this.kickoffIndex += 1;
      } else if (this.kickoffIndex === -1) {
        const ball = w.ball.pos;
        const dist = w.cars.map(c => Math.hypot(c.body.pos.x - ball.x, c.body.pos.y - ball.y) * BT);
        const me = w.cars[this.index];
        let taker = false;
        if (Math.abs(Math.min(...dist) - dist[this.index]) <= 10) {
          taker = true;
          w.cars.forEach((c, i) => {
            if (i === this.index || c.team !== me.team || Math.abs(dist[i] - dist[this.index]) > 10) return;
            const isLeft = me.team === 'blue' ? c.body.pos.x < me.body.pos.x : c.body.pos.x > me.body.pos.x;
            if (!isLeft) taker = false; // left goes
          });
        }
        this.kickoffIndex = taker ? 0 : -2;
      }
      if (this.kickoffIndex >= 0 && this.kickoffIndex < KICKOFF.length && w.ball.pos.y === 0) {
        this.action = KICKOFF[this.kickoffIndex].slice();
        this.updateControls(this.action);
      }
    }
  }

  // ---------------- Necto ----------------
  class NectoBot extends RLGymBot {
    constructor(world, carIndex) { super(world, carIndex, 'Necto', 'necto'); }

    reset() {
      super.reset();
      this.demoTimers = new Map();
      this.boostTimers = null;
    }

    // necto_obs.py NectoObsBuilder.build_obs -> q (32), kv (entities x 24)
    buildObs() {
      const players = this.players(), n = players.length, pads = this.padsActive();
      const rows = 1 + n + BOOST_LOCATIONS.length, qkv = new Float32Array(rows * 24);
      qkv[3] = 1;
      this.setPhysicsRow(qkv, 0, this.ballData());
      players.forEach((p, idx) => {
        const r = (1 + idx) * 24;
        qkv[r + (p.team === 0 ? 1 : 2)] = 1;
        this.setPhysicsRow(qkv, r, p);
        qkv[r + 11] = p.fwd[0]; qkv[r + 12] = p.fwd[1]; qkv[r + 13] = p.fwd[2];
        qkv[r + 14] = p.up[0]; qkv[r + 15] = p.up[1]; qkv[r + 16] = p.up[2];
        qkv[r + 20] = p.boost;
        qkv[r + 22] = p.onGround;
        qkv[r + 23] = p.hasFlip;
        // "Different than training": the demo timer cycles 3 -> 0 regardless of demolitions
        let t = this.demoTimers.get(p.id) || 0;
        t = t <= 0 ? 3 : Math.max(t - TICK_SKIP / 120, 0);
        this.demoTimers.set(p.id, t);
        qkv[r + 21] = t / 10;
      });
      if (!this.boostTimers) this.boostTimers = new Float32Array(BOOST_LOCATIONS.length);
      BOOST_LOCATIONS.forEach((loc, j) => {
        const r = (1 + n + j) * 24, big = loc[2] > 72 ? 1 : 0;
        qkv[r + 4] = 1;
        qkv[r + 5] = loc[0]; qkv[r + 6] = loc[1]; qkv[r + 7] = loc[2];
        qkv[r + 20] = 0.12 + 0.88 * big;
        if (pads[j] === 1 && this.boostTimers[j] === 0) this.boostTimers[j] = 0.4 + 0.6 * big;
        this.boostTimers[j] *= pads[j];
        qkv[r + 21] = this.boostTimers[j];
        this.boostTimers[j] = Math.max(this.boostTimers[j] - TICK_SKIP / 1200, 0);
      });
      for (let r = 0; r < rows; r++) for (let c = 0; c < 24; c++) qkv[r * 24 + c] /= NORM[c];
      qkv[24] = 1; // is_main (self is player 0, entity 1)
      if (players[0].team === 1) {
        for (let r = 0; r < rows; r++) {
          const o = r * 24, mate = qkv[o + 1];
          qkv[o + 1] = qkv[o + 2]; qkv[o + 2] = mate;
          for (let c = 0; c < 24; c++) qkv[o + c] *= INVERT[c];
        }
      }
      const q = new Float32Array(32);
      q.set(qkv.subarray(24, 48));
      for (let i = 0; i < 8; i++) q[24 + i] = this.action[i];
      for (let r = 0; r < rows; r++) for (let c = 5; c < 11; c++) qkv[r * 24 + c] -= q[c];
      return { q, kv: qkv, nk: rows };
    }

    // agent.py act with beta = 1 (argmax per head) and its action parsing
    act() {
      const { q, kv, nk } = this.buildObs();
      const logits = nectoForward(this.weights, q, kv, nk);
      const throttle = argmax(logits, 0, 3) - 1, steer = argmax(logits, 3, 3) - 1;
      const jump = argmax(logits, 6, 2), boost = argmax(logits, 8, 2), handbrake = argmax(logits, 10, 2);
      return [throttle, steer, throttle, steer * (1 - handbrake), steer * handbrake, jump, boost, handbrake];
    }

    // Necto bot.py get_output
    tick() {
      if (!this.ready) return this.controls;
      this.trackGround();
      this.ticks += 1;
      if (this.updateAction) {
        this.updateAction = false;
        this.action = this.act();
      }
      if (this.ticks >= TICK_SKIP) {
        this.ticks = 0;
        this.updateControls(this.action);
        this.updateAction = true;
      }
      this.maybeKickoff();
      return this.controls;
    }
  }

  // ---------------- Nexto ----------------
  class NextoBot extends RLGymBot {
    constructor(world, carIndex) { super(world, carIndex, 'Nexto', 'nexto'); }

    // nexto_obs.py NextoObsBuilder.batched_build_obs for this bot's perspective
    buildObs() {
      const players = this.players(), n = players.length, pads = this.padsActive();
      const rows = n + 1 + BOOST_LOCATIONS.length, kv = new Float32Array(rows * 24);
      const ballRow = n * 24;
      kv[ballRow + 3] = 1;
      this.setPhysicsRow(kv, ballRow, this.ballData());
      BOOST_LOCATIONS.forEach((loc, j) => {
        const r = (n + 1 + j) * 24;
        kv[r + 4] = 1;
        kv[r + 5] = loc[0]; kv[r + 6] = loc[1]; kv[r + 7] = loc[2];
        kv[r + 20] = 0.12 + 0.88 * (loc[2] > 72 ? 1 : 0);
        kv[r + 21] = pads[j];
      });
      players.forEach((p, idx) => {
        const r = idx * 24;
        if (idx === 0) kv[r] = 1;
        kv[r + 1] = 1 - p.team;
        kv[r + 2] = p.team;
        this.setPhysicsRow(kv, r, p);
        kv[r + 11] = p.fwd[0]; kv[r + 12] = p.fwd[1]; kv[r + 13] = p.fwd[2];
        kv[r + 14] = p.up[0]; kv[r + 15] = p.up[1]; kv[r + 16] = p.up[2];
        kv[r + 20] = p.boost;
        kv[r + 21] = p.demoed;
        kv[r + 22] = p.onGround;
        kv[r + 23] = p.hasFlip;
      });
      if (players[0].team === 1) {
        for (let r = 0; r < rows; r++) {
          const o = r * 24;
          for (let c = 0; c < 24; c++) kv[o + c] *= INVERT[c];
          const mate = kv[o + 1];
          kv[o + 1] = kv[o + 2]; kv[o + 2] = mate;
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < 24; c++) kv[r * 24 + c] /= NORM[c];
      const q = new Float32Array(32);
      q.set(kv.subarray(0, 24));
      for (let i = 0; i < 8; i++) q[24 + i] = this.action[i];
      // convert_to_relative: positions relative to self, then rotated by self's facing
      const theta = Math.atan2(q[11], q[12]), ct = Math.cos(theta), st = Math.sin(theta);
      for (let r = 0; r < rows; r++) {
        const o = r * 24;
        kv[o + 5] -= q[5]; kv[o + 6] -= q[6]; kv[o + 7] -= q[7];
        for (const c of [5, 8, 11, 14, 17]) {
          const x = kv[o + c], y = kv[o + c + 1];
          kv[o + c] = ct * x - st * y;
          kv[o + c + 1] = st * x + ct * y;
        }
      }
      return { q, kv, nk: rows };
    }

    // agent.py act: argmax (beta 1), or sampling from the policy (beta 0.5) during kickoff pauses
    act(beta) {
      const { q, kv, nk } = this.buildObs();
      const logits = nextoForward(this.weights, q, kv, nk);
      let index;
      if (beta === 1) {
        index = argmax(logits, 0, 90);
      } else {
        const scale = Math.log((beta + 1) / (1 - beta)) / Math.log(3);
        let max = -Infinity;
        for (let i = 0; i < 90; i++) max = Math.max(max, logits[i] * scale);
        const p = Array.from(logits, l => Math.exp(l * scale - max));
        let r = Math.random() * p.reduce((a, b) => a + b, 0);
        index = 89;
        for (let i = 0; i < 90; i++) { r -= p[i]; if (r <= 0) { index = i; break; } }
      }
      return NEXTO_ACTIONS[index].slice();
    }

    // Nexto bot.py get_output (beta 1, hardcoded and stochastic kickoffs)
    tick() {
      if (!this.ready) return this.controls;
      this.trackGround();
      this.ticks += 1;
      if (this.updateAction) {
        this.updateAction = false;
        this.action = this.act(this.world.kickoffPause ? 0.5 : 1);
      }
      if (this.ticks >= TICK_SKIP - 1) this.updateControls(this.action);
      if (this.ticks >= TICK_SKIP) {
        this.ticks = 0;
        this.updateAction = true;
      }
      this.maybeKickoff();
      return this.controls;
    }
  }

  // Opponent entries, placed right after Element
  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'element') + 1, 0,
    { id: 'necto', name: 'Necto', desc: 'Champion-level challenger. Necto is the official RLGym community bot by Rolv, Soren and contributors, trained with reinforcement learning on workers run by players all over the world. Faster kickoffs, sharper touches and relentless pressure: expect every mistake to be punished.',
      modes: ['1v1', '2v2', '3v3'], make: (w, i) => new NectoBot(w, i), load: () => loadModel('necto') },
    { id: 'nexto', name: 'Nexto', desc: 'Grand Champion-level challenger. Nexto is version 2 of Necto, the official RLGym community bot (Rolv, Soren and contributors). Wins 50/50s, reads your touches, takes to the air and turns almost any mistake into a goal.',
      modes: ['1v1', '2v2', '3v3'], make: (w, i) => new NextoBot(w, i), load: () => loadModel('nexto') });

  return { NectoBot, NextoBot, loadModel, NEXTO_ACTIONS, nectoForward, nextoForward };
})();
