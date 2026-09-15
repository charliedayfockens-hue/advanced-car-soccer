// Goal explosion upgrade: adds cinematic layers on top of every goal explosion in effects.js.
//  - velocity-stretched glowing streak sparks (camera-facing ribbons, visible from across the pitch)
//  - god rays, energy shockwave shells, anamorphic lens flares, glowing floor scorches and a bloom pulse
//  - per explosion: Classic double blast, Party Time confetti cannons with sweeping disco lights, Fireworks with a
//    second volley, willow trails, crackle and a finale, Hellfire fire tornado with meteors, Dueling Dragons with
//    segmented bodies, flapping wings, fire breath and a clash, Voxel block shockwave and pixel sparks
window.Game = window.Game || {};

(function () {
  const P = Game.Effects.Effects.prototype;
  const rand = (a, b) => a + Math.random() * (b - a);
  const WHITE = new THREE.Color(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  const isDark = c => Math.max(c.r, c.g, c.b) < 0.5;
  const additiveColor = c => (isDark(c) ? new THREE.Color(0.45, 0.45, 0.5) : c);

  // ---------------- textures ----------------
  function canvasTexture(size, draw) {
    const c = document.createElement('canvas');
    c.width = size[0]; c.height = size[1];
    draw(c.getContext('2d'), size[0], size[1]);
    return new THREE.CanvasTexture(c);
  }
  const RAY_TEX = canvasTexture([64, 256], (g, w, h) => {
    const along = g.createLinearGradient(0, h, 0, 0);
    along.addColorStop(0, 'rgba(255,255,255,1)'); along.addColorStop(0.35, 'rgba(255,255,255,0.45)'); along.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = along; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(0,0,0,0)'); across.addColorStop(0.5, 'rgba(0,0,0,1)'); across.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = across; g.fillRect(0, 0, w, h);
  });
  const FLARE_TEX = canvasTexture([256, 32], (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.2, 'rgba(255,255,255,0.5)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const SCORCH_TEX = canvasTexture([256, 256], (g, w) => {
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.55, 'rgba(255,255,255,0.35)'); r.addColorStop(0.8, 'rgba(255,255,255,0.7)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });

  // ---------------- streak sparks ----------------
  const STREAK_VERT = `
    attribute vec3 aHead; attribute vec3 aTail; attribute vec4 aColor; attribute vec3 aCorner;
    varying vec4 vColor; varying float vSide; varying float vAlong;
    void main() {
      vec4 h = modelViewMatrix * vec4(aHead, 1.0), t = modelViewMatrix * vec4(aTail, 1.0);
      vec3 p = mix(h.xyz, t.xyz, aCorner.x);
      vec3 d = t.xyz - h.xyz;
      vec3 side = normalize(cross(length(d) > 0.001 ? d : vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0)));
      p += side * aCorner.y * aCorner.z * (1.0 - 0.7 * aCorner.x);
      vColor = aColor; vSide = aCorner.y; vAlong = aCorner.x;
      gl_Position = projectionMatrix * vec4(p, 1.0);
    }`;
  const STREAK_FRAG = `
    varying vec4 vColor; varying float vSide; varying float vAlong;
    void main() {
      float a = vColor.a * (1.0 - vAlong) * (1.0 - vSide * vSide);
      gl_FragColor = vec4(vColor.rgb * (1.0 + 1.5 * (1.0 - vAlong)), a);
    }`;

  class Streaks {
    constructor(scene, cap) {
      this.cap = cap; this.next = 0;
      this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3); this.c = new Float32Array(cap * 3);
      this.life = new Float32Array(cap); this.max = new Float32Array(cap); this.width = new Float32Array(cap);
      this.stretch = new Float32Array(cap); this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
      const geo = new THREE.BufferGeometry();
      this.head = new Float32Array(cap * 12); this.tail = new Float32Array(cap * 12);
      this.color = new Float32Array(cap * 16); this.corner = new Float32Array(cap * 12);
      const index = new Uint32Array(cap * 6);
      for (let i = 0; i < cap; i++) {
        const v = i * 4, k = i * 6;
        [[0, -1], [0, 1], [1, -1], [1, 1]].forEach(([x, y], j) => { this.corner[(v + j) * 3] = x; this.corner[(v + j) * 3 + 1] = y; });
        index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], k);
      }
      geo.setAttribute('aHead', new THREE.BufferAttribute(this.head, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aTail', new THREE.BufferAttribute(this.tail, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aCorner', new THREE.BufferAttribute(this.corner, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 12), 3));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      this.geo = geo;
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      this.alive = 0;
    }

    emit(pos, vel, color, life, o) {
      o = o || {};
      const i = this.next;
      this.next = (i + 1) % this.cap;
      this.p.set([pos.x, pos.y, pos.z], i * 3); this.v.set([vel.x, vel.y, vel.z], i * 3); this.c.set([color.r, color.g, color.b], i * 3);
      this.life[i] = this.max[i] = life;
      this.width[i] = o.width || 14; this.stretch[i] = o.stretch || 0.06; this.drag[i] = o.drag || 0; this.grav[i] = o.gravity || 0;
      this.alive = Math.max(this.alive, 1);
    }

    update(dt) {
      if (!this.alive) return;
      let alive = 0;
      for (let i = 0; i < this.cap; i++) {
        const i3 = i * 3, v4 = i * 4;
        if (this.life[i] <= 0) { for (let j = 0; j < 4; j++) this.color[(v4 + j) * 4 + 3] = 0; continue; }
        alive++;
        this.life[i] -= dt;
        const k = Math.max(0, 1 - this.drag[i] * dt);
        this.v[i3] *= k; this.v[i3 + 1] = this.v[i3 + 1] * k - this.grav[i] * dt; this.v[i3 + 2] *= k;
        this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
        const t = Math.max(this.life[i], 0) / this.max[i], a = Math.pow(t, 1.3), s = this.stretch[i];
        for (let j = 0; j < 4; j++) {
          const o3 = (v4 + j) * 3;
          this.head[o3] = this.p[i3]; this.head[o3 + 1] = this.p[i3 + 1]; this.head[o3 + 2] = this.p[i3 + 2];
          this.tail[o3] = this.p[i3] - this.v[i3] * s; this.tail[o3 + 1] = this.p[i3 + 1] - this.v[i3 + 1] * s; this.tail[o3 + 2] = this.p[i3 + 2] - this.v[i3 + 2] * s;
          this.corner[o3 + 2] = this.width[i] * (0.4 + 0.6 * t);
          const o4 = (v4 + j) * 4;
          this.color[o4] = this.c[i3]; this.color[o4 + 1] = this.c[i3 + 1]; this.color[o4 + 2] = this.c[i3 + 2]; this.color[o4 + 3] = a;
        }
      }
      this.alive = alive;
      const at = this.geo.attributes;
      at.aHead.needsUpdate = at.aTail.needsUpdate = at.aColor.needsUpdate = at.aCorner.needsUpdate = true;
    }
  }

  // ---------------- hero layers ----------------
  P.fx = function () {
    if (!this._fx) this._fx = { streaks: new Streaks(this.scene, 5000) };
    return this._fx;
  };

  P.streakBurst = function (pos, color, count, speed, o) {
    o = o || {};
    const s = this.fx().streaks, bias = o.bias;
    for (let i = 0; i < count; i++) {
      const d = new THREE.Vector3(rand(-1, 1), rand(o.minY === undefined ? -1 : o.minY, 1), rand(-1, 1)).normalize();
      if (bias) d.addScaledVector(bias, o.biasAmount || 0.6).normalize();
      const c = Math.random() < (o.white || 0.25) ? WHITE : color;
      s.emit(pos, d.multiplyScalar(rand(speed[0], speed[1])), c, rand(o.life ? o.life[0] : 0.5, o.life ? o.life[1] : 1.2),
        { width: rand(o.width ? o.width[0] : 10, o.width ? o.width[1] : 22), stretch: o.stretch || 0.07, drag: o.drag === undefined ? 1.6 : o.drag, gravity: o.gravity === undefined ? 700 : o.gravity });
    }
  };

  P.godRays = function (pos, color, count, length, dur, bias) {
    const c = additiveColor(color);
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ map: RAY_TEX, color: c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
      const a = new THREE.Mesh(geo, mat), b = new THREE.Mesh(geo, mat);
      b.rotation.y = Math.PI / 2;
      group.add(a, b);
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
      if (bias) dir.addScaledVector(bias, 0.5).normalize();
      group.quaternion.setFromUnitVectors(UP, dir);
      group.position.copy(pos);
      this.scene.add(group);
      const len = length * rand(0.6, 1.2), wid = length * rand(0.05, 0.12), spin = rand(-0.6, 0.6), delay = rand(0, 0.12);
      this.addActor((act, dt) => {
        const t = act.t - delay;
        if (t < 0) return true;
        const k = Math.min(t / dur, 1);
        group.scale.set(wid * (1 - 0.5 * k), len * (0.25 + 0.75 * Math.sqrt(k)), 1);
        group.rotateOnAxis(UP, spin * dt);
        mat.opacity = Math.sin(Math.PI * Math.min(k * 1.6, 1)) * (1 - k) * 1.4;
        if (k >= 1) { this.scene.remove(group); mat.dispose(); geo.dispose(); return false; }
        return true;
      });
    }
  };

  P.energyShell = function (pos, color, radius, dur, strength) {
    const dark = isDark(color);
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: dark ? new THREE.Color(0, 0, 0) : color.clone() }, opacity: { value: 1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 color; uniform float opacity; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); gl_FragColor = vec4(color * (0.6 + 2.2 * f), f * opacity); }',
      transparent: true, depthWrite: false, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), mat);
    mesh.position.copy(pos);
    mesh.renderOrder = 6;
    this.scene.add(mesh);
    this.addActor(act => {
      const k = Math.min(act.t / dur, 1);
      mesh.scale.setScalar(radius * (0.08 + 0.92 * (1 - Math.pow(1 - k, 3))));
      mat.uniforms.opacity.value = (strength || 1) * (1 - k) * (1 - k);
      if (k >= 1) { this.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); return false; }
      return true;
    });
  };

  P.lensFlare = function (pos, color, size, dur) {
    const mat = new THREE.SpriteMaterial({ map: FLARE_TEX, color: additiveColor(color).clone().lerp(WHITE, 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.renderOrder = 8;
    this.scene.add(s);
    this.addActor(act => {
      const k = Math.min(act.t / dur, 1);
      s.scale.set(size * (0.6 + 0.8 * k), size * 0.07, 1);
      mat.opacity = (1 - k) * (1 - k);
      if (k >= 1) { this.scene.remove(s); mat.dispose(); return false; }
      return true;
    });
  };

  P.floorScorch = function (x, z, color, radius, dur) {
    const mat = new THREE.MeshBasicMaterial({ map: SCORCH_TEX, color: additiveColor(color), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 48), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 4, z);
    mesh.renderOrder = 3;
    this.scene.add(mesh);
    this.addActor(act => {
      const k = Math.min(act.t / dur, 1);
      mesh.scale.setScalar(radius * (0.3 + 0.7 * Math.min(act.t / 0.35, 1)));
      mat.opacity = Math.min(act.t / 0.1, 1) * Math.pow(1 - k, 1.5) * 0.9;
      if (k >= 1) { this.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); return false; }
      return true;
    });
  };

  P.pulseBloom = function (amount) { this.bloomBoost = Math.min((this.bloomBoost || 0) + amount, 2.2); };
  P.later = function (delay, fn) { this.addActor(act => { if (act.t < delay) return true; fn(); return false; }); };

  const baseUpdate = P.update;
  P.update = function (dt) {
    baseUpdate.call(this, dt);
    if (this._fx) this._fx.streaks.update(dt);
    this.bloomBoost = (this.bloomBoost || 0) * Math.exp(-2.4 * dt);
  };

  // ---------------- per explosion ----------------
  const base = {
    classic: P.goalClassic, partyTime: P.goalPartyTime, fireworks: P.goalFireworks,
    hellfire: P.goalHellfire, dragons: P.goalDragons, voxel: P.goalVoxel, fireworkBurst: P.fireworkBurst
  };

  // Classic: flash, shell and god rays, then a second blast a beat later
  P.goalClassic = function (pos, team, n, painted) {
    base.classic.call(this, pos, team, n, painted);
    const glow = additiveColor(team), hot = glow.clone().lerp(WHITE, 0.4);
    this.energyShell(pos, team, 1800, 0.9, 1.2);
    this.godRays(pos, hot, 18, 2600, 1.2, n);
    this.lensFlare(pos, hot, 6000, 0.8);
    this.streakBurst(pos, glow, 420, [1200, 4200], { bias: n, biasAmount: 0.4, minY: -0.1, gravity: 900, life: [0.6, 1.5], width: [12, 30] });
    this.floorScorch(pos.x, pos.z + n.z * 250, glow, 1800, 3.2);
    this.pulseBloom(1.6);
    this.later(0.22, () => {
      this.energyShell(pos.clone().addScaledVector(n, 200), hot, 3200, 1.1, 0.8);
      this.shockRing(pos.clone().addScaledVector(n, 150), n, hot, 3800, 1.0, 0.05, 0.9);
      this.streakBurst(pos, WHITE, 160, [2500, 5200], { bias: n, biasAmount: 0.8, gravity: 300, life: [0.3, 0.7], width: [8, 16], stretch: 0.05 });
      this.addShake(1.0);
      this.pulseBloom(0.6);
    });
    for (let i = 0; i < 220; i++) {
      const p = pos.clone().add(new THREE.Vector3(rand(-900, 900), rand(0, 900), rand(-400, 400)).addScaledVector(n, rand(0, 900)));
      this.glow.emit(p.x, p.y, p.z, rand(-60, 60), rand(20, 160), rand(-60, 60), rand(2, 3.8), rand(14, 26), Math.random() < 0.5 ? WHITE : glow, { drag: 0.6, gravity: -20, twinkle: 1 });
    }
  };

  // Party Time: three confetti cannon waves, streamers and sweeping disco lights
  P.goalPartyTime = function (pos, team, n, painted) {
    base.partyTime.call(this, pos, team, n, painted);
    const palette = painted ? [team, team.clone().offsetHSL(0, 0, 0.15), WHITE]
      : [0xff3b6b, 0xffc93c, 0x3ddc97, 0x3aa0ff, 0xb05cff, 0xff8a2b].map(h => new THREE.Color(h));
    [0.55, 1.1, 1.65].forEach((delay, w) => this.later(delay, () => {
      const s = w % 2 ? 1 : -1, origin = new THREE.Vector3(s * rand(400, 760), 90, pos.z);
      this.burstFlash(origin, WHITE, 700, 0.2, 0.9);
      for (let i = 0; i < 260; i++) {
        const dir = n.clone().multiplyScalar(rand(0.4, 1)).add(new THREE.Vector3(-s * rand(0, 0.7), rand(0.7, 1.6), 0)).normalize().multiplyScalar(rand(900, 2300));
        this.confetti.emit(origin, dir, palette[i % palette.length], rand(22, 36), rand(3, 5), { gravity: 260, drag: 1.4, spin: 10, flutter: 200 });
      }
      palette.forEach((c, i) => this.streakBurst(origin, additiveColor(c), 10, [1400, 2600], { bias: new THREE.Vector3(-s * 0.3, 1, n.z * 0.6), biasAmount: 1.4, gravity: 500, life: [0.9, 1.6], width: [10, 16], stretch: 0.12, white: 0 }));
      this.addShake(0.4);
      if (this.onPop) this.onPop(origin);
    }));
    // Disco spotlights sweeping the pitch from above the goal
    for (let i = 0; i < 6; i++) {
      const color = additiveColor(palette[i % palette.length]);
      const mat = new THREE.MeshBasicMaterial({ map: RAY_TEX, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const geo = new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0);
      const beam = new THREE.Group();
      [0, Math.PI / 2].forEach(r => { const m = new THREE.Mesh(geo, mat); m.rotation.y = r; beam.add(m); });
      beam.position.set((i - 2.5) * 320, 1500, pos.z + n.z * 300);
      beam.scale.set(260, 2200, 1);
      this.scene.add(beam);
      const phase = rand(0, 6.28), speed = rand(1.5, 2.6);
      this.addActor(act => {
        const k = Math.min(act.t / 4.2, 1);
        beam.rotation.set(Math.sin(act.t * speed + phase) * 0.7 + n.z * 0.5, 0, Math.cos(act.t * speed * 0.8 + phase) * 0.6);
        mat.opacity = Math.min(act.t / 0.4, 1) * (1 - k) * 0.55;
        if (k >= 1) { this.scene.remove(beam); mat.dispose(); geo.dispose(); return false; }
        return true;
      });
    }
    this.godRays(pos, WHITE, 10, 1600, 1.0, n);
    this.pulseBloom(0.8);
  };

  // Fireworks: willow trails and crackle on every burst, a second volley and a finale
  P.fireworkBurst = function (p, color, generation, painted) {
    base.fireworkBurst.call(this, p, color, generation, painted);
    const glow = additiveColor(color);
    if (generation === 1) {
      this.streakBurst(p, glow, 90, [500, 1000], { gravity: 380, drag: 1.1, life: [1.2, 2.2], width: [10, 18], stretch: 0.14, white: 0.1 });
      this.energyShell(p, color, 700, 0.5, 0.6);
      this.pulseBloom(0.35);
      this.later(rand(0.7, 1.0), () => {
        for (let i = 0; i < 70; i++) {
          const q = p.clone().add(new THREE.Vector3(rand(-600, 600), rand(-700, 300), rand(-600, 600)));
          this.glow.emit(q.x, q.y, q.z, 0, rand(-40, 0), 0, rand(0.15, 0.45), rand(22, 40), WHITE, { twinkle: 1 });
        }
      });
    }
  };

  P.goalFireworks = function (pos, team, n, painted) {
    base.fireworks.call(this, pos, team, n, painted);
    this.godRays(pos, additiveColor(team), 8, 1400, 0.8, n);
    this.later(0.95, () => base.fireworks.call(this, pos, team, n, painted));
    this.later(2.3, () => {
      const top = new THREE.Vector3(0, 1350, pos.z + n.z * 900);
      const colors = painted ? [team, WHITE] : [team, WHITE, new THREE.Color(1, 0.8, 0.3)];
      colors.forEach((c, i) => this.later(i * 0.08, () => this.fireworkBurst(top.clone().add(new THREE.Vector3(rand(-300, 300), rand(-150, 150), 0)), c.clone(), 1, painted)));
      this.streakBurst(top, additiveColor(team), 260, [900, 1900], { gravity: 260, life: [1.4, 2.4], width: [14, 24], stretch: 0.1 });
      this.energyShell(top, team, 1600, 0.8, 0.9);
      this.lensFlare(top, WHITE, 5000, 0.6);
      this.addShake(1.2);
      this.pulseBloom(1.2);
    });
  };

  // Hellfire: a spinning fire tornado that flings meteors onto the pitch
  P.goalHellfire = function (pos, team, n, painted) {
    base.hellfire.call(this, pos, team, n, painted);
    const dark = painted && isDark(team);
    const fireCol = heat => (painted ? team.clone().lerp(WHITE, dark ? heat * 0.1 : heat * 0.4) : new THREE.Color(1, 0.2 + heat * 0.65, heat * 0.2));
    const glow = painted ? additiveColor(team) : new THREE.Color(1, 0.4, 0.08);
    const floor = new THREE.Vector3(pos.x * 0.5, 20, pos.z + n.z * 150);
    let carry = 0;
    this.addActor((act, dt) => {
      const k = act.t / 2.6;
      if (k >= 1) return false;
      carry += dt * 320;
      for (; carry >= 1; carry--) {
        const h = rand(0, 1800), ang = act.t * 7 + h * 0.004 + rand(0, 6.28), r = 80 + h * 0.28;
        const q = floor.clone().add(new THREE.Vector3(Math.cos(ang) * r, h, Math.sin(ang) * r * 0.7));
        const tangent = new THREE.Vector3(-Math.sin(ang), 0.9, Math.cos(ang) * 0.7).multiplyScalar(rand(500, 900));
        this.paintEmit(dark, q.x, q.y, q.z, tangent.x, tangent.y, tangent.z, rand(0.25, 0.5), rand(110, 220) * (1 - k * 0.5), fireCol(Math.random()), { drag: 2, grow: -0.4, opacity: 0.85 });
      }
      return true;
    });
    this.floorScorch(floor.x, floor.z, glow, 2200, 4);
    this.godRays(floor.clone().setY(300), glow, 14, 2400, 1.4, UP);
    this.energyShell(pos, glow, 1500, 0.7, 0.9);
    this.pulseBloom(1.4);
    for (let m = 0; m < 12; m++) {
      this.later(0.3 + m * 0.12, () => {
        const start = floor.clone().setY(rand(900, 1500));
        const vel = new THREE.Vector3(rand(-1500, 1500), rand(300, 900), 0).addScaledVector(n, rand(700, 1800));
        const p = start.clone();
        this.addActor((act, dt) => {
          vel.y -= 1300 * dt;
          p.addScaledVector(vel, dt);
          this.fx().streaks.emit(p, vel.clone().multiplyScalar(0.25), fireCol(Math.random()), 0.35, { width: 40, stretch: 0.25, drag: 3 });
          this.paintEmit(dark, p.x, p.y, p.z, rand(-50, 50), rand(0, 80), rand(-50, 50), rand(0.4, 0.8), rand(60, 110), fireCol(Math.random()), { grow: 1, drag: 1.5, opacity: 0.6 });
          if (p.y <= 20 || act.t > 3) {
            p.y = 20;
            this.burstFlash(p, glow, 700, 0.3, 0.9);
            this.shockRing(new THREE.Vector3(p.x, 6, p.z), UP, glow, 520, 0.5, 0.2, 0.8);
            this.streakBurst(p, glow, 30, [300, 900], { minY: 0.2, gravity: 1200, life: [0.4, 0.8], width: [8, 14] });
            this.addShake(0.25);
            return false;
          }
          return true;
        });
      });
    }
  };

  // Dueling Dragons: glowing segmented bodies with flapping wings, fire breath and a clash at the top
  P.goalDragons = function (pos, team, n, painted) {
    base.dragons.call(this, pos, team, n, painted);
    const colors = painted ? [team.clone(), team.clone().offsetHSL(0, 0, isDark(team) ? 0.1 : 0.18)]
      : [team.clone().lerp(WHITE, 0.15), new THREE.Color(1, 0.62, 0.12)];
    const origin = new THREE.Vector3(0, 80, pos.z), T = 2.8;
    // Same flight path as the base effect's dragon heads
    const path = (phase, t) => {
      const ang = phase + t * 4.6, radius = 320 + 160 * Math.sin(t * 2.2);
      const p = origin.clone().addScaledVector(n, 350 + t * 520);
      p.x += Math.cos(ang) * radius;
      p.y = 120 + t * 620 + Math.sin(ang) * radius * 0.6;
      return p;
    };
    colors.forEach((color, d) => {
      const phase = d * Math.PI, glow = additiveColor(color);
      const segs = [];
      for (let s = 0; s < 16; s++) {
        const mat = new THREE.SpriteMaterial({ map: SCORCH_TEX, color: glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        const sp = new THREE.Sprite(mat);
        this.scene.add(sp);
        segs.push(sp);
      }
      const wingMat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const wingGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0.15, 1), new THREE.Vector3(-0.35, 0, 0.35), new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0.15, -1), new THREE.Vector3(-0.35, 0, -0.35)]);
      const wings = new THREE.Mesh(wingGeo, wingMat);
      this.scene.add(wings);
      this.addActor(act => {
        const t = act.t, k = t / T;
        if (k >= 1) {
          segs.forEach(sp => { this.scene.remove(sp); sp.material.dispose(); });
          this.scene.remove(wings); wingMat.dispose(); wingGeo.dispose();
          return false;
        }
        const fade = Math.min(t * 4, 1) * (1 - k * k);
        segs.forEach((sp, s) => {
          const q = path(phase, Math.max(t - s * 0.05, 0));
          sp.position.copy(q);
          const size = (300 - s * 15) * (0.8 + 0.2 * Math.sin(t * 20 - s));
          sp.scale.set(size, size, 1);
          sp.material.opacity = fade * (1 - s / 18) * 0.9;
        });
        const head = path(phase, t), ahead = path(phase, t + 0.03), dir = ahead.clone().sub(head).normalize();
        wings.position.copy(head);
        wings.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
        const flap = Math.sin(t * 16) * 0.8;
        wings.scale.set(260, 260 * (1 + flap), 520);
        wingMat.opacity = fade * 0.6;
        if (Math.random() < 0.6) {
          this.fx().streaks.emit(head, dir.clone().multiplyScalar(rand(900, 1600)).add(new THREE.Vector3(rand(-150, 150), rand(-150, 150), rand(-150, 150))), glow.clone().lerp(WHITE, 0.3), rand(0.25, 0.45), { width: rand(18, 30), stretch: 0.12, drag: 2 });
        }
        return true;
      });
    });
    this.later(T - 0.05, () => {
      const top = path(0, T).lerp(path(Math.PI, T), 0.5);
      const glow = additiveColor(colors[0]);
      this.energyShell(top, colors[0], 1400, 0.7, 1.1);
      this.godRays(top, glow.clone().lerp(WHITE, 0.3), 14, 1800, 1.0);
      this.streakBurst(top, glow, 200, [900, 2200], { gravity: 500, life: [0.6, 1.3], width: [12, 24] });
      this.lensFlare(top, WHITE, 5200, 0.7);
      this.addShake(1.4);
      this.pulseBloom(1.3);
    });
    this.energyShell(pos, colors[1], 1200, 0.6, 0.8);
    this.pulseBloom(0.8);
  };

  // Voxel: a ring of blocks rolling across the floor and square pixel sparks
  P.goalVoxel = function (pos, team, n, painted) {
    base.voxel.call(this, pos, team, n, painted);
    const teamGlow = isDark(team) ? team.clone() : team.clone().multiplyScalar(1.8);
    const fire = [new THREE.Color(2.2, 1.9, 0.6), new THREE.Color(2.2, 1.1, 0.2), new THREE.Color(1.8, 0.35, 0.08)];
    for (let wave = 0; wave < 3; wave++) {
      this.later(wave * 0.18, () => {
        const center = new THREE.Vector3(pos.x * 0.5, 30, pos.z + n.z * 120);
        for (let i = 0; i < 90; i++) {
          const a = (i / 90) * Math.PI * 2;
          const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
          if (dir.dot(n) < -0.2) continue;
          const v = dir.clone().multiplyScalar(rand(1400, 2200) - wave * 300).setY(rand(150, 450));
          this.voxels.emit(center.clone().addScaledVector(dir, 150), v, i % 2 ? teamGlow : fire[i % 3], 36 - wave * 6, rand(0.8, 1.2), { gravity: 900, drag: 1.4, shrink: true });
        }
      });
    }
    for (let i = 0; i < 160; i++) {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().addScaledVector(n, 0.5).normalize().multiplyScalar(rand(900, 2600));
      this.voxels.emit(pos, v, Math.random() < 0.5 ? teamGlow : WHITE.clone().multiplyScalar(2), rand(10, 18), rand(0.8, 1.6), { gravity: 700, drag: 1, shrink: true, spin: 8 });
    }
    this.shockRing(new THREE.Vector3(pos.x, 8, pos.z), UP, additiveColor(team), 3000, 1.0, 0.18, 0.9);
    this.godRays(pos, additiveColor(team), 10, 2000, 1.0, n);
    this.pulseBloom(1.0);
  };
})();
