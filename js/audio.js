// Game audio. Most sounds are synthesized with WebAudio (impacts, flips, goal explosion, countdown, UI
// ticks, standard boost). Sample files cover the alpha boost (start, loop, release) and the first and
// second jump; the synthesized versions play until those have loaded. One master level from Settings > Audio.
window.Game = window.Game || {};

Game.Audio = (function () {
  let ctx = null, master = null, noiseBuf = null;
  let boost = null, alphaBoost = null;
  let volume = 0.6;

  const SAMPLES = {
    boostStart: 'assets/audio/boost_alpha_1.mp3',
    boostEnd: 'assets/audio/boost_alpha_2.mp3',
    boostLoop: 'assets/audio/boost_alpha_3.mp3',
    jump: 'assets/audio/jump.mp3',
    secondJump: 'assets/audio/second_jump.mp3'
  };
  const buffers = {};
  let samplesRequested = false;

  function loadSamples() {
    if (samplesRequested) return;
    samplesRequested = true;
    Object.entries(SAMPLES).forEach(([key, url]) => {
      Game.Assets.fetchChecked(url, { kind: 'MP3', check: Game.Assets.isMp3 })
        .then(buf => ctx.decodeAudioData(buf))
        .then(audio => { buffers[key] = audio; })
        .catch(err => Game.Assets.report(err, url));
    });
  }

  function makeNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function noiseSource(loop) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = !!loop;
    return s;
  }

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = makeNoise();

    // Standard boost: airy filtered noise, only audible while boosting
    const bGain = ctx.createGain(); bGain.gain.value = 0;
    const bFilter = ctx.createBiquadFilter(); bFilter.type = 'bandpass'; bFilter.frequency.value = 1400; bFilter.Q.value = 0.7;
    const bSrc = noiseSource(true);
    bSrc.connect(bFilter); bFilter.connect(bGain); bGain.connect(master); bSrc.start();
    boost = { gain: bGain, filter: bFilter };
    loadSamples();
    return true;
  }

  function setVolume(pct) {
    volume = Math.max(0, Math.min(1, pct / 100));
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
  }

  // Plays a loaded sample once; returns null if it hasn't loaded
  function playSample(key, gain) {
    const buffer = buffers[key];
    if (!buffer || !ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(master);
    src.start();
    return { src, g };
  }

  // Alpha boost: ignition one-shot, then the loop fades in; letting go fades the loop and plays the release
  function updateAlphaBoost(on, active, t) {
    if (on && !alphaBoost) {
      const start = playSample('boostStart', 0.9);
      const loopGain = ctx.createGain();
      loopGain.gain.setValueAtTime(0, t);
      loopGain.gain.setTargetAtTime(0.75, t + 0.12, 0.08);
      const loop = ctx.createBufferSource();
      loop.buffer = buffers.boostLoop;
      loop.loop = true;
      loop.connect(loopGain); loopGain.connect(master);
      loop.start(t);
      alphaBoost = { start, loop, loopGain };
    } else if (!on && alphaBoost) {
      alphaBoost.loopGain.gain.setTargetAtTime(0, t, 0.04);
      alphaBoost.loop.stop(t + 0.3);
      if (alphaBoost.start) {
        alphaBoost.start.g.gain.setTargetAtTime(0, t, 0.05);
        alphaBoost.start.src.stop(t + 0.3);
      }
      if (active) playSample('boostEnd', 0.8);
      alphaBoost = null;
    }
  }

  function update(s) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const useAlpha = !!(s.alpha && buffers.boostLoop);
    updateAlphaBoost(s.active && s.boosting && useAlpha, s.active, t);
    boost.gain.gain.setTargetAtTime(s.active && s.boosting && !useAlpha ? 0.14 : 0, t, s.boosting ? 0.03 : 0.08);
    boost.filter.frequency.setTargetAtTime(s.supersonic ? 2200 : 1400, t, 0.2);
  }

  function burst(opts) {
    if (!ensure()) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);
    const f = ctx.createBiquadFilter();
    f.type = opts.filter || 'lowpass';
    f.frequency.value = opts.freq;
    if (opts.q) f.Q.value = opts.q;
    const src = noiseSource(false);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random());
    src.stop(t + opts.decay + 0.05);
  }

  function tone(opts) {
    if (!ensure()) return;
    const t = ctx.currentTime + (opts.delay || 0);
    const o = ctx.createOscillator();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.from, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);
    o.connect(g); g.connect(master);
    o.start(t);
    o.stop(t + opts.decay + 0.05);
  }

  return {
    unlock: ensure,
    setVolume,
    update,
    // Ball hit: a deep thump, a hollow metallic ring from the ball shell, and a bright crack on big hits
    carBallHit(strength) {
      const k = Math.min(strength / 3000, 1);
      if (k < 0.02) return;
      tone({ from: 170, to: 55, gain: 0.35 + k * 0.45, decay: 0.22, type: 'sine', attack: 0.003 });
      tone({ from: 620 + k * 180, to: 540, gain: 0.08 + k * 0.12, decay: 0.35, type: 'triangle', attack: 0.002 });
      tone({ from: 1240 + k * 300, to: 1100, gain: 0.03 + k * 0.05, decay: 0.25, type: 'sine', attack: 0.002 });
      burst({ gain: 0.2 + k * 0.55, decay: 0.07 + k * 0.12, freq: 1800 + k * 3200, filter: 'bandpass', q: 0.9, attack: 0.002 });
      if (k > 0.55) burst({ gain: 0.35 * k, decay: 0.05, freq: 5000, filter: 'highpass', attack: 0.001 });
    },
    ballBounce(strength) {
      const k = Math.min(strength / 2500, 1);
      if (k < 0.04) return;
      burst({ gain: 0.05 + k * 0.35, decay: 0.08 + k * 0.12, freq: 500 + k * 1200 });
    },
    carImpact(strength) {
      const k = Math.min(strength / 1500, 1);
      if (k < 0.1) return;
      burst({ gain: 0.05 + k * 0.25, decay: 0.1 + k * 0.1, freq: 400 + k * 900 });
    },
    // Jump (second = double jump): sample, or a suspension "chunk" plus a short air puff until it loads
    jump(second) {
      if (!ensure()) return;
      if (playSample(second ? 'secondJump' : 'jump', 1)) return;
      tone({ from: 95, to: 60, gain: 0.22, decay: 0.12, type: 'sine', attack: 0.002 });
      burst({ gain: 0.12, decay: 0.14, freq: 900, filter: 'bandpass', q: 0.7, attack: 0.004 });
      tone({ from: 300, to: 520, gain: 0.04, decay: 0.1, type: 'triangle' });
    },
    // Flip: the second-jump sound with a rising whoosh as the car spins
    flip() {
      if (!ensure()) return;
      const sampled = playSample('secondJump', 1);
      burst({ gain: sampled ? 0.08 : 0.16, decay: 0.32, freq: 1200, filter: 'bandpass', q: 1.2, attack: 0.03 });
      if (!sampled) tone({ from: 180, to: 420, gain: 0.05, decay: 0.28, type: 'sawtooth', attack: 0.02 });
    },
    goal() {
      if (!ensure()) return;
      tone({ from: 90, to: 30, gain: 0.9, decay: 1.2, type: 'sine' });
      burst({ gain: 0.9, decay: 1.6, freq: 1800, attack: 0.01 });
      [0, 0.18, 0.36].forEach((d, i) => tone({ from: 392 * [1, 1.26, 1.5][i], gain: 0.12, decay: 0.9, delay: 0.25 + d, type: 'sawtooth' }));
    },
    // Flip reset: bright two-note chime with a sparkle on top
    flipReset() {
      tone({ from: 988, gain: 0.14, decay: 0.3, type: 'triangle', attack: 0.004 });
      tone({ from: 1480, gain: 0.14, decay: 0.45, delay: 0.08, type: 'triangle', attack: 0.004 });
      tone({ from: 2960, gain: 0.04, decay: 0.35, delay: 0.08, type: 'sine' });
      burst({ gain: 0.05, decay: 0.2, freq: 7000, filter: 'highpass', attack: 0.01 });
    },
    sonicBoom() {
      burst({ gain: 0.35, decay: 0.55, freq: 850, filter: 'bandpass', q: 0.5, attack: 0.02 });
      tone({ from: 130, to: 45, gain: 0.25, decay: 0.45 });
    },
    countdown(go) { tone({ from: go ? 880 : 520, gain: 0.22, decay: go ? 0.55 : 0.25, type: 'square', attack: 0.005 }); },
    whoosh() { burst({ gain: 0.18, decay: 0.45, freq: 700, filter: 'bandpass', q: 0.6, attack: 0.12 }); },
    uiHover() { tone({ from: 1400, gain: 0.02, decay: 0.04, type: 'sine' }); },
    uiSelect() { tone({ from: 900, to: 1300, gain: 0.05, decay: 0.08, type: 'triangle' }); }
  };
})();
