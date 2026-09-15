// Game audio. Every sound is a recording (CC0 libraries: Kenney, rubberduck on OpenGameArt, SFXMint; see
// assets/audio/CREDITS.txt) plus the alpha boost and jump samples, layered and varied in WebAudio:
//  - hits, bounces, bumps, demolitions, goal explosions and balloon/firework pops play in 3D around the camera
//  - variants are picked at random and pitched slightly so repeats don't sound identical
//  - the boost roar and an engine hum loop seamlessly and follow speed, throttle and supersonic
// One master level from Settings > Audio.
window.Game = window.Game || {};

Game.Audio = (function () {
  const A = 'assets/audio/', X = A + 'sfx/';
  const FILES = {
    boostStart: A + 'boost_alpha_1.mp3', boostEnd: A + 'boost_alpha_2.mp3', boostAlphaLoop: A + 'boost_alpha_3.mp3',
    jump: A + 'jump.mp3', secondJump: A + 'second_jump.mp3',
    ballHit_1: X + 'ball_hit_1.mp3', ballHit_2: X + 'ball_hit_2.mp3', ballHit_3: X + 'ball_hit_3.mp3',
    ballRing_1: X + 'ball_ring_1.mp3', ballRing_2: X + 'ball_ring_2.mp3',
    bounce_1: X + 'bounce_1.mp3', bounce_2: X + 'bounce_2.mp3', bounce_3: X + 'bounce_3.mp3',
    land_1: X + 'land_1.mp3', land_2: X + 'land_2.mp3',
    bump_1: X + 'bump_1.mp3', bump_2: X + 'bump_2.mp3',
    demo: X + 'demo.mp3', sonicBoom: X + 'sonic_boom.mp3',
    pickupSmall: X + 'pickup_small.mp3', pickupBig: X + 'pickup_big.mp3', flipReset: X + 'flip_reset.mp3',
    countTick: X + 'count_tick.mp3', countGo: X + 'count_go.mp3', replayWhoosh: X + 'replay_whoosh.mp3',
    uiHover: X + 'ui_hover.mp3', uiSelect: X + 'ui_select.mp3',
    goalClassic: X + 'goal_classic.mp3', goalFireworks: X + 'goal_fireworks.mp3', fireworkPop: X + 'firework_pop.mp3',
    goalHellfire: X + 'goal_hellfire.mp3', goalDragons: X + 'goal_dragons.mp3', goalVoxel: X + 'goal_voxel.mp3',
    pop_1: X + 'pop_1.mp3', pop_2: X + 'pop_2.mp3',
    cheer_1: X + 'cheer_1.mp3', cheer_2: X + 'cheer_2.mp3', cheer_3: X + 'cheer_3.mp3',
    boostLoop: X + 'boost_loop.mp3', engineLoop: X + 'engine_loop.mp3'
  };
  // Seamless loops: the files carry 0.25 s of wrap-around padding each side so encoder delay can't click
  const LOOPS = { boostLoop: { start: 0.25, length: 3.6 }, engineLoop: { start: 0.25, length: 3.6 } };
  const GOAL_SOUND = { classic: 'goalClassic', partyTime: 'goalClassic', fireworks: 'goalFireworks', hellfire: 'goalHellfire', dragons: 'goalDragons', voxel: 'goalVoxel' };

  let ctx = null, master = null, volume = 0.6, requested = false;
  const buffers = {};
  const loops = {};
  let alphaBoost = null;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp01 = v => Math.max(0, Math.min(1, v));

  function load() {
    if (requested) return;
    requested = true;
    Object.entries(FILES).forEach(([key, url]) => {
      Game.Assets.fetchChecked(url, { kind: 'MP3', check: Game.Assets.isMp3 })
        .then(buf => ctx.decodeAudioData(buf))
        .then(audio => { buffers[key] = audio; })
        .catch(err => Game.Assets.report(err, url));
    });
  }

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
    master.connect(comp);
    comp.connect(ctx.destination);
    load();
    return true;
  }

  function setVolume(pct) {
    volume = Math.max(0, Math.min(1, pct / 100));
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
  }

  // Random variant of a sound: 'ballHit' picks ballHit_1..n
  function bufferFor(name) {
    if (buffers[name]) return buffers[name];
    const variants = [];
    for (let i = 1; buffers[name + '_' + i] || FILES[name + '_' + i]; i++) if (buffers[name + '_' + i]) variants.push(buffers[name + '_' + i]);
    return variants.length ? variants[Math.floor(Math.random() * variants.length)] : null;
  }

  function setVec(param3, v) {
    if (param3[0].setTargetAtTime) { const t = ctx.currentTime; param3.forEach((p, i) => p.setValueAtTime(v[i], t)); }
  }

  // Camera position and orientation for 3D sounds (three.js world units)
  const _f = new THREE.Vector3(), _u = new THREE.Vector3();
  function setListener(camera) {
    if (!ctx) return;
    const L = ctx.listener, p = camera.position;
    _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (L.positionX) {
      setVec([L.positionX, L.positionY, L.positionZ], [p.x, p.y, p.z]);
      setVec([L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ], [_f.x, _f.y, _f.z, _u.x, _u.y, _u.z]);
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z);
    }
  }

  // o: { gain, rate, pos (THREE.Vector3), ref (distance at full volume), rolloff, delay }
  function play(name, o) {
    if (!ensure()) return null;
    o = o || {};
    const buffer = bufferFor(name);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate || 1;
    const g = ctx.createGain();
    g.gain.value = o.gain === undefined ? 1 : o.gain;
    src.connect(g);
    let out = g;
    if (o.pos) {
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = o.ref || 700;
      pan.rolloffFactor = o.rolloff === undefined ? 0.8 : o.rolloff;
      pan.maxDistance = 30000;
      if (pan.positionX) setVec([pan.positionX, pan.positionY, pan.positionZ], [o.pos.x, o.pos.y, o.pos.z]);
      else pan.setPosition(o.pos.x, o.pos.y, o.pos.z);
      g.connect(pan);
      out = pan;
    }
    out.connect(master);
    src.start(ctx.currentTime + (o.delay || 0));
    return { src, g };
  }

  function startLoop(name) {
    const buffer = buffers[name], meta = LOOPS[name];
    if (!buffer || loops[name]) return loops[name] || null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = meta.start;
    src.loopEnd = meta.start + meta.length;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g); g.connect(master);
    src.start(0, meta.start);
    return (loops[name] = { src, g });
  }

  // Alpha boost: ignition one-shot, then its loop fades in; letting go fades the loop and plays the release
  function updateAlphaBoost(on, active, t) {
    if (on && !alphaBoost) {
      const start = play('boostStart', { gain: 0.85 });
      const loopGain = ctx.createGain();
      loopGain.gain.setValueAtTime(0, t);
      loopGain.gain.setTargetAtTime(0.7, t + 0.12, 0.08);
      const loop = ctx.createBufferSource();
      loop.buffer = buffers.boostAlphaLoop;
      loop.loop = true;
      loop.connect(loopGain); loopGain.connect(master);
      loop.start(t);
      alphaBoost = { start, loop, loopGain };
    } else if (!on && alphaBoost) {
      alphaBoost.loopGain.gain.setTargetAtTime(0, t, 0.04);
      alphaBoost.loop.stop(t + 0.3);
      if (alphaBoost.start) { alphaBoost.start.g.gain.setTargetAtTime(0, t, 0.05); alphaBoost.start.src.stop(t + 0.3); }
      if (active) play('boostEnd', { gain: 0.75 });
      alphaBoost = null;
    }
  }

  // s: { active, speed (uu/s), throttle, boosting, supersonic, alpha }
  function update(s) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const k = clamp01(s.speed / 2300);

    const engine = startLoop('engineLoop');
    if (engine) {
      engine.src.playbackRate.setTargetAtTime(0.62 + 0.75 * k + (s.supersonic ? 0.08 : 0), t, 0.1);
      engine.g.gain.setTargetAtTime(s.active ? 0.05 + 0.1 * k + 0.05 * Math.abs(s.throttle || 0) : 0, t, 0.12);
    }

    const useAlpha = !!(s.alpha && buffers.boostAlphaLoop);
    updateAlphaBoost(s.active && s.boosting && useAlpha, s.active, t);
    const roar = startLoop('boostLoop');
    if (roar) {
      const on = s.active && s.boosting && !useAlpha;
      roar.g.gain.setTargetAtTime(on ? 0.5 : 0, t, on ? 0.035 : 0.12);
      roar.src.playbackRate.setTargetAtTime(s.supersonic ? 1.1 : 0.96 + 0.08 * k, t, 0.2);
    }
  }

  return {
    unlock: ensure,
    setVolume,
    setListener,
    update,
    // Ball hit: a heavy body thump, plus the metal shell ringing on harder touches
    carBallHit(strength, pos) {
      const k = clamp01(strength / 3000);
      if (k < 0.02) return;
      play('ballHit', { gain: 0.35 + 0.65 * k, rate: 1.06 - 0.16 * k + rand(-0.04, 0.04), pos, ref: 900 });
      if (k > 0.12) play('ballRing', { gain: 0.15 + 0.55 * k, rate: rand(0.94, 1.06), pos, ref: 900 });
    },
    ballBounce(strength, pos) {
      const k = clamp01(strength / 2500);
      if (k < 0.04) return;
      play('bounce', { gain: 0.12 + 0.6 * k, rate: rand(0.94, 1.08), pos, ref: 900 });
    },
    carImpact(strength, pos) {
      const k = clamp01(strength / 1500);
      if (k < 0.1) return;
      play('land', { gain: 0.12 + 0.5 * k, rate: rand(0.92, 1.05), pos, ref: 700 });
    },
    bump(strength, pos) {
      const k = clamp01(strength / 2300);
      play('bump', { gain: 0.3 + 0.6 * k, rate: rand(0.92, 1.04), pos, ref: 900 });
      play('land', { gain: 0.2 + 0.4 * k, rate: 0.82, pos, ref: 900 });
    },
    demolition(pos) { play('demo', { gain: 1, rate: rand(0.95, 1.03), pos, ref: 1600, rolloff: 0.6 }); },
    sonicBoom() { play('sonicBoom', { gain: 0.4 }); },
    jump(second) { play(second ? 'secondJump' : 'jump', { gain: 0.9 }); },
    flip() { play('secondJump', { gain: 0.9 }); },
    flipReset() { play('flipReset', { gain: 0.5 }); },
    boostPickup(big) { play(big ? 'pickupBig' : 'pickupSmall', { gain: big ? 0.45 : 0.3, rate: rand(0.97, 1.03) }); },
    // Goal: the explosion's own blast at the goal, then the crowd
    goal(type, pos) {
      play(GOAL_SOUND[type] || 'goalClassic', { gain: 1, pos, ref: 4000, rolloff: 0.4 });
      play('cheer', { gain: type === 'partyTime' ? 0.8 : 0.55, delay: 0.2 });
      if (type === 'partyTime') play('cheer', { gain: 0.45, delay: 1.1 });
    },
    pop(pos) { play('pop', { gain: 0.55, rate: rand(0.85, 1.2), pos, ref: 2500, rolloff: 0.5 }); },
    firework(pos, generation) { play('fireworkPop', { gain: generation === 1 ? 0.75 : 0.35, rate: rand(0.85, 1.15), pos, ref: 3000, rolloff: 0.4 }); },
    countdown(go) { play(go ? 'countGo' : 'countTick', { gain: 0.6 }); },
    whoosh() { play('replayWhoosh', { gain: 0.5 }); },
    uiHover() { play('uiHover', { gain: 0.22 }); },
    uiSelect() { play('uiSelect', { gain: 0.38 }); }
  };
})();
