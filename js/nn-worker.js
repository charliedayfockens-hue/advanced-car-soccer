// Feed-forward policy network (rlgym-ppo DiscreteFF: Linear+ReLU x4, Linear -> argmax) for the big RL bots.
// Weights come from a compact float16 file: 'ACBW' + uint32 header length + JSON [{name, shape, offset}] + data.
// Runs as a Web Worker so the ~7.6M-weight forward pass never stalls rendering; the same file also loads as a
// normal script (Game.PolicyNet) as a fallback when workers aren't available.
(function (root) {
  function float16To32(bytes, offset, count) {
    const out = new Float32Array(count), dv = new DataView(bytes.buffer, bytes.byteOffset + offset, count * 2);
    for (let i = 0; i < count; i++) {
      const h = dv.getUint16(i * 2, true), s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      out[i] = e === 0 ? s * f * Math.pow(2, -24) : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * Math.pow(2, e - 15);
    }
    return out;
  }

  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'ACBW') throw new Error('not a policy weight file');
    const headLen = new DataView(buffer).getUint32(4, true);
    const layers = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen)));
    const data = bytes.subarray(8 + headLen), w = {};
    layers.forEach(l => { w[l.name] = { shape: l.shape, data: float16To32(data, l.offset, l.shape.reduce((a, b) => a * b, 1)) }; });
    const net = [];
    for (let i = 0; w['model.' + i + '.weight']; i += 2) net.push({ W: w['model.' + i + '.weight'], b: w['model.' + i + '.bias'] });
    if (net.length < 2) throw new Error('policy weight file has no layers');
    return net;
  }

  // Returns the index of the largest logit
  function forward(net, obs) {
    let x = obs;
    for (let l = 0; l < net.length; l++) {
      const { W, b } = net[l], out = W.shape[0], inp = W.shape[1], y = new Float32Array(out), last = l === net.length - 1;
      for (let o = 0; o < out; o++) {
        let s = b.data[o];
        const row = o * inp;
        for (let i = 0; i < inp; i++) s += W.data[row + i] * x[i];
        y[o] = !last && s < 0 ? 0 : s;
      }
      x = y;
    }
    let best = 0;
    for (let i = 1; i < x.length; i++) if (x[i] > x[best]) best = i;
    return best;
  }

  if (typeof window === 'undefined') {
    let net = null;
    self.onmessage = e => {
      const m = e.data;
      if (m.type === 'init') {
        try { net = parse(m.buffer); self.postMessage({ type: 'ready' }); } catch (err) { self.postMessage({ type: 'error', message: String(err) }); }
      } else if (m.type === 'act' && net) {
        self.postMessage({ type: 'action', id: m.id, action: forward(net, m.obs) });
      }
    };
  } else {
    root.Game = root.Game || {};
    root.Game.PolicyNet = { parse, forward };
  }
})(typeof window === 'undefined' ? self : window);
