// Sixteen more goal explosions in the style of Rocket League's: Singularity, Meteor Storm, Neuro-Agitator,
// Big Splash, Atomizer, Shattered, Gold Rush, Toon, Force Razor, Ballistic, Poly Pop, Sub-Zero, Solar Flare,
// Distortion, Popcorn and Mushroom Cloud. Each is recreated from how it looks, built from geometry, particles
// and shaders at runtime, and uses the paint colour picked in the Garage (team colour when unpainted).
window.Game = window.Game || {};

(function () {
  const E = Game.Effects, P = E.Effects.prototype;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const WHITE = new THREE.Color(1, 1, 1), UP = V(0, 1, 0);
  const isDark = c => Math.max(c.r, c.g, c.b) < 0.5;
  const glowOf = c => (isDark(c) ? c.clone().lerp(WHITE, 0.4) : c.clone());
  const randDir = (minY = -1) => V(rand(-1, 1), rand(minY, 1), rand(-1, 1)).normalize();

  // Adds a mesh for `dur` seconds, calling update(k, t, dt) every frame, then removes and disposes it
  P.meshFor = function (mesh, dur, update, keepGeometry) {
    this.scene.add(mesh);
    this.addActor((a, dt) => {
      const k = Math.min(a.t / dur, 1);
      if (update) update(k, a.t, dt);
      if (k < 1) return true;
      this.scene.remove(mesh);
      mesh.traverse(o => {
        if (o.geometry && !keepGeometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => m.dispose());
      });
      return false;
    });
    return mesh;
  };

  const additive = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opacity === undefined ? 1 : opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });

  // Jagged lightning drawn with short streak ribbons
  P.bolt = function (a, b, color, width, jag) {
    const segs = 10, pts = [a.clone()];
    const dir = b.clone().sub(a), len = dir.length();
    for (let i = 1; i < segs; i++) pts.push(a.clone().addScaledVector(dir, i / segs).add(randDir().multiplyScalar(len * (jag || 0.06))));
    pts.push(b.clone());
    const s = this.fx().streaks;
    for (let i = 0; i < segs; i++) {
      const p = pts[i + 1], v = pts[i + 1].clone().sub(pts[i]);
      s.emit(p, v.multiplyScalar(1 / 0.06), color, 0.07, { width, stretch: 0.06, drag: 0, gravity: 0 });
    }
  };

  // A small bouncing piece that rolls to a stop on the floor (coins, kernels, shards)
  function bouncer(pos, vel, radius) {
    return { p: pos.clone(), v: vel.clone(), r: radius, spin: V(rand(-8, 8), rand(-8, 8), rand(-8, 8)), rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)) };
  }
  function stepBouncer(b, dt, gravity) {
    b.v.y -= (gravity || 1300) * dt;
    b.p.addScaledVector(b.v, dt);
    if (b.p.y < b.r) { b.p.y = b.r; b.v.y = Math.abs(b.v.y) * 0.45; b.v.x *= 0.8; b.v.z *= 0.8; b.spin.multiplyScalar(0.8); }
    b.rot.x += b.spin.x * dt; b.rot.y += b.spin.y * dt; b.rot.z += b.spin.z * dt;
  }

  // Instanced group of bouncers drawn with one mesh
  P.bouncers = function (geometry, material, list, dur, gravity, fadeScale) {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V(1, 1, 1);
    mesh.frustumCulled = false;
    return this.meshFor(mesh, dur, (k, t, dt) => {
      const shrink = fadeScale ? 1 - smooth(0.75, 1, k) : 1;
      list.forEach((b, i) => {
        if (t >= (b.delay || 0)) stepBouncer(b, dt, gravity);
        q.setFromEuler(b.rot);
        s.setScalar(t >= (b.delay || 0) ? shrink * (b.scale || 1) : 0.0001);
        m.compose(b.p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  };

  const NOISE = `
    float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h3(i), h3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(h3(i + vec3(0.0, 1.0, 0.0)), h3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                 mix(mix(h3(i + vec3(0.0, 0.0, 1.0)), h3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(h3(i + vec3(0.0, 1.0, 1.0)), h3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }
    float fbm3(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * n3(p); p *= 2.02; a *= 0.5; } return v; }`;

  // ---------------- 1. Singularity: a black hole with an accretion disk that swallows light, then detonates ----------------
  function singularity(pos, team, n) {
    const glow = glowOf(team), c = pos.clone().addScaledVector(n, 350).setY(500), T = 2.6;
    const core = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.meshFor(core, T, k => core.scale.setScalar(20 + 280 * smooth(0, 0.3, k) * (1 - smooth(0.85, 0.92, k))));
    const diskMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: glow }, fade: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: NOISE + `uniform float time; uniform vec3 color; uniform float fade; varying vec2 vUv;
        void main() { vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0 || r < 0.28) discard;
          float a = atan(p.y, p.x); float swirl = fbm3(vec3(a * 3.0 + r * 8.0 - time * 7.0, r * 4.0, time));
          float band = smoothstep(0.28, 0.4, r) * smoothstep(1.0, 0.55, r);
          vec3 col = mix(color, vec3(1.0, 0.95, 0.9), smoothstep(0.55, 0.3, r)) * (0.6 + 1.4 * swirl);
          gl_FragColor = vec4(col * band * 2.0 * fade, band * fade); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diskMat);
    disk.position.copy(c);
    disk.rotation.set(-1.2, 0, 0.3);
    this.meshFor(disk, T, (k, t) => { diskMat.uniforms.time.value = t; diskMat.uniforms.fade.value = smooth(0, 0.2, k) * (1 - smooth(0.82, 0.9, k)); disk.scale.setScalar(900 * (0.4 + 0.6 * smooth(0, 0.35, k)) * (1 - 0.8 * smooth(0.8, 0.9, k))); });
    // Matter spiralling in
    let carry = 0;
    this.addActor((a, dt) => {
      if (a.t > T * 0.85) return false;
      carry += dt * 220;
      for (; carry >= 1; carry--) {
        const ang = rand(0, 6.28), r = rand(1400, 2600), p = c.clone().add(V(Math.cos(ang) * r, rand(-500, 500), Math.sin(ang) * r));
        const inward = c.clone().sub(p).normalize(), tangent = V(-inward.z, 0, inward.x);
        const v = inward.multiplyScalar(rand(900, 1500)).addScaledVector(tangent, rand(700, 1200));
        this.glow.emit(p.x, p.y, p.z, v.x, v.y, v.z, rand(1.0, 1.6), rand(30, 70), Math.random() < 0.3 ? WHITE : glow, { drag: 0.2, grow: -0.8 });
      }
      return true;
    });
    this.lensFlare(c, glow, 3000, 0.6);
    this.later(T * 0.88, () => {
      this.burstFlash(c, WHITE, 6000, 0.5, 1);
      this.energyShell(c, glow, 3200, 1.1, 1.3);
      this.shockRing(c, V(0, 1, 0), glow, 4500, 1.2, 0.05, 1);
      this.shockRing(c, n, glow, 3800, 1.0, 0.05, 0.9);
      this.streakBurst(c, glow, 360, [1800, 5200], { gravity: 150, life: [0.5, 1.2], width: [10, 26] });
      this.godRays(c, glow, 20, 3200, 1.2);
      this.lightFlash(c, glow, 7);
      this.addShake(2.6);
      this.pulseBloom(2);
    });
    this.addShake(0.6);
    this.pulseBloom(0.6);
  }

  // ---------------- 2. Meteor Storm: flaming rocks rain down onto the goal ----------------
  function meteorStorm(pos, team, n) {
    const glow = glowOf(team), dark = isDark(team);
    const rockGeo = new THREE.IcosahedronGeometry(1, 0), rockMat = new THREE.MeshStandardMaterial({ color: 0x3a2c26, roughness: 1, flatShading: true, emissive: glow, emissiveIntensity: 0.6 });
    for (let i = 0; i < 14; i++) {
      this.later(i * 0.13 + rand(0, 0.08), () => {
        const hit = V(pos.x * 0.4 + rand(-1300, 1300), 0, pos.z + n.z * rand(200, 1900));
        const p = hit.clone().add(V(rand(-1800, 1800), rand(3600, 5200), -n.z * rand(500, 1800))), v = hit.clone().sub(p).normalize().multiplyScalar(rand(3600, 4600));
        const size = rand(70, 150), rock = new THREE.Mesh(rockGeo, rockMat.clone());
        rock.scale.setScalar(size);
        let done = false;
        this.meshFor(rock, 2, (k, t, dt) => {
          if (done) { rock.visible = false; return; }
          p.addScaledVector(v, dt);
          rock.position.copy(p);
          rock.rotation.x += dt * 5; rock.rotation.y += dt * 4;
          this.fx().streaks.emit(p, v.clone().multiplyScalar(0.18), glow.clone().lerp(WHITE, 0.3), 0.25, { width: size * 0.9, stretch: 0.1, drag: 2 });
          this.paintEmit(dark, p.x, p.y, p.z, rand(-60, 60), rand(-60, 60), rand(-60, 60), rand(0.3, 0.6), size * rand(1.6, 2.4), glow, { grow: 1.2, drag: 2, opacity: 0.8 });
          if (p.y <= 20) {
            done = true;
            this.burstFlash(V(p.x, 60, p.z), glow.clone().lerp(WHITE, 0.3), size * 10, 0.3, 1);
            this.shockRing(V(p.x, 8, p.z), UP, glow, size * 9, 0.6, 0.18, 0.9);
            this.floorScorch(p.x, p.z, glow, size * 4, 2.5);
            this.streakBurst(V(p.x, 30, p.z), glow, 30, [500, 1400], { minY: 0.2, gravity: 1400, life: [0.4, 0.9], width: [8, 18] });
            for (let j = 0; j < 14; j++) { const d = randDir(0.2).multiplyScalar(rand(300, 900)); this.voxels.emit(V(p.x, 30, p.z), d, new THREE.Color(0.2, 0.15, 0.12), rand(14, 30), rand(0.8, 1.4), { gravity: 1400, drag: 0.5, shrink: true, spin: 8 }); }
            for (let j = 0; j < 8; j++) this.smoke.emit(p.x, 80, p.z, rand(-150, 150), rand(150, 450), rand(-150, 150), rand(1.2, 2.2), rand(160, 300), new THREE.Color(0.18, 0.15, 0.14), { grow: 2, drag: 1.3, opacity: 0.4 });
            this.addShake(0.35);
            this.pulseBloom(0.15);
          }
        }, true);
      });
    }
    this.godRays(pos.clone().setY(3000), glow, 10, 3500, 1.8, V(0, -1, 0));
  }

  // ---------------- 3. Neuro-Agitator: tesla coils rise and arc lightning into a charged core ----------------
  function neuroAgitator(pos, team, n) {
    const glow = glowOf(team).lerp(new THREE.Color(0.6, 0.85, 1), isDark(team) ? 0.2 : 0.35), T = 2.8;
    const c = pos.clone().addScaledVector(n, 700).setY(420);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3038, metalness: 0.9, roughness: 0.35 });
    const tops = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4, base = c.clone().add(V(Math.cos(a) * 1000, 0, Math.sin(a) * 700)).setY(0);
      const coil = new THREE.Group();
      coil.add(new THREE.Mesh(new THREE.CylinderGeometry(55, 90, 700, 12).translate(0, 350, 0), metal));
      for (let r = 0; r < 5; r++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(95 - r * 6, 16, 8, 20), metal); ring.rotation.x = Math.PI / 2; ring.position.y = 160 + r * 110; coil.add(ring); }
      const orb = new THREE.Mesh(new THREE.SphereGeometry(80, 16, 12), additive(glow));
      orb.position.y = 780;
      coil.add(orb);
      coil.position.copy(base);
      tops.push(base.clone().setY(780));
      this.meshFor(coil, T, k => { coil.position.y = -800 * (1 - smooth(0, 0.18, k)) - 900 * smooth(0.9, 1, k); orb.scale.setScalar(0.8 + 0.4 * Math.random()); }, false);
    }
    const coreMat = additive(glow);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), coreMat);
    core.position.copy(c);
    this.meshFor(core, T, k => core.scale.setScalar(120 * smooth(0.1, 0.8, k) * (0.85 + 0.3 * Math.random()) * (1 - smooth(0.82, 0.86, k))));
    this.addActor(a => {
      if (a.t > T * 0.84) return false;
      if (a.t < 0.35) return true;
      tops.forEach((t, i) => {
        if (Math.random() < 0.55) this.bolt(tops[i].clone().setY(tops[i].y + (a.t < 0.5 ? -800 * (1 - smooth(0, 0.5, a.t)) : 0)), c, glow, rand(14, 26), 0.08);
        if (Math.random() < 0.25) this.bolt(tops[i], tops[(i + 1) % 4], WHITE, rand(8, 14), 0.07);
      });
      if (Math.random() < 0.3) this.bolt(c, c.clone().add(randDir(0).multiplyScalar(rand(900, 1600))).setY(0), glow, 10, 0.12);
      return true;
    });
    this.later(T * 0.84, () => {
      this.burstFlash(c, WHITE, 5000, 0.4, 1);
      this.energyShell(c, glow, 2600, 0.9, 1.2);
      for (let i = 0; i < 14; i++) this.bolt(c, c.clone().add(randDir(-0.2).multiplyScalar(rand(1500, 3000))), glow, rand(16, 30), 0.1);
      this.streakBurst(c, glow, 260, [1400, 4000], { gravity: 500, life: [0.4, 1.0], width: [8, 18] });
      this.shockRing(V(c.x, 8, c.z), UP, glow, 4200, 1.0, 0.04, 1);
      this.lightFlash(c, glow, 6);
      this.addShake(2.2);
      this.pulseBloom(1.8);
    });
    this.addShake(0.8);
  }

  // ---------------- 4. Big Splash: a wave of water erupts from the goal ----------------
  function bigSplash(pos, team, n, painted) {
    const water = painted ? team.clone() : new THREE.Color(0.25, 0.62, 1.0), foam = new THREE.Color(0.9, 0.97, 1);
    const c = pos.clone().addScaledVector(n, 200).setY(0);
    const colMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: water }, fade: { value: 1 } },
      vertexShader: 'varying vec2 vUv; varying vec3 vN; void main() { vUv = uv; vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: NOISE + `uniform float time; uniform vec3 color; uniform float fade; varying vec2 vUv; varying vec3 vN;
        void main() { float f = fbm3(vec3(vUv.x * 12.0, vUv.y * 4.0 - time * 3.0, time));
          float edge = pow(1.0 - abs(normalize(vN).z), 2.0);
          vec3 col = mix(color, vec3(0.9, 0.97, 1.0), smoothstep(0.55, 0.8, f) + vUv.y * 0.4);
          gl_FragColor = vec4(col, (0.45 + 0.4 * f + edge * 0.2) * fade * smoothstep(1.0, 0.7, vUv.y)); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(260, 520, 1, 32, 8, true).translate(0, 0.5, 0), colMat);
    column.position.copy(c);
    this.meshFor(column, 2.2, (k, t) => {
      colMat.uniforms.time.value = t;
      column.scale.set(1 + k * 0.8, 2600 * Math.sin(Math.min(k * 2.2, 1) * Math.PI / 2) * (1 - smooth(0.55, 1, k)) + 1, 1 + k * 0.8);
      colMat.uniforms.fade.value = 1 - smooth(0.6, 1, k);
    });
    // Droplets and foam spray
    for (let i = 0; i < 900; i++) {
      const d = randDir(0.2).addScaledVector(n, 0.5).normalize().multiplyScalar(rand(600, 2600)), foamy = Math.random() < 0.35;
      this.smoke.emit(c.x + rand(-200, 200), rand(50, 400), c.z + rand(-200, 200), d.x, d.y + rand(300, 900), d.z, rand(1.0, 2.2), rand(28, 70), foamy ? foam : water, { gravity: 1100, drag: 0.6, opacity: 0.85, grow: -0.3 });
    }
    for (let i = 0; i < 40; i++) this.smoke.emit(c.x + rand(-400, 400), rand(50, 300), c.z + rand(-300, 300), rand(-300, 300), rand(200, 700), rand(-300, 300), rand(1.4, 2.4), rand(250, 450), foam, { grow: 2, drag: 1.2, gravity: 100, opacity: 0.35 });
    [0, 0.25, 0.5, 0.8].forEach(d => this.later(d, () => this.shockRing(V(c.x, 8, c.z), UP, water.clone().lerp(WHITE, 0.5), 3200, 1.6, 0.06, 0.8)));
    this.later(1.1, () => {
      for (let i = 0; i < 300; i++) { const p = V(c.x + rand(-2000, 2000), 3, c.z + n.z * rand(0, 2800)); this.glow.emit(p.x, p.y, p.z, 0, rand(60, 200), 0, rand(0.4, 0.9), rand(12, 26), foam, { gravity: 300 }); }
    });
    this.burstFlash(c.clone().setY(300), foam, 2600, 0.35, 0.6);
    this.addShake(1.6);
    this.pulseBloom(0.5);
  }

  // ---------------- 5. Atomizer: electrons orbit a glowing nucleus, then it splits ----------------
  function atomizer(pos, team, n) {
    const glow = glowOf(team), c = pos.clone().addScaledVector(n, 600).setY(600), T = 2.4;
    const nucleus = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), additive(glow.clone().lerp(WHITE, 0.3)));
    nucleus.position.copy(c);
    this.meshFor(nucleus, T, (k, t) => nucleus.scale.setScalar((120 + 60 * Math.sin(t * 20) * k) * smooth(0, 0.15, k) * (1 - smooth(0.85, 0.88, k))));
    const orbits = [0, 1, 2].map(i => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 96), additive(glow, 0.8));
      ring.position.copy(c);
      ring.rotation.set(i * 1.05, i * 0.7, i * 0.4);
      const e = new THREE.Mesh(new THREE.SphereGeometry(40, 12, 8), additive(WHITE));
      ring.add(e);
      e.scale.setScalar(1 / 700); // electron radius 40 uu in world space
      this.meshFor(ring, T, (k, t) => {
        const r = 700 * smooth(0, 0.2, k) * (1 - 0.85 * smooth(0.6, 0.86, k));
        ring.scale.setScalar(Math.max(r, 1));
        const a = t * (6 + 22 * k) + i * 2;
        e.position.set(Math.cos(a), Math.sin(a), 0);
        e.scale.setScalar(1 / Math.max(r, 1));
        const w = ring.localToWorld(e.position.clone());
        if (Math.random() < 0.8) this.fx().streaks.emit(w, V(rand(-50, 50), rand(-50, 50), rand(-50, 50)), glow, 0.25, { width: 26, stretch: 0.05 });
        if (k >= 1) ring.remove(e);
      });
      return ring;
    });
    this.later(T * 0.87, () => {
      this.burstFlash(c, WHITE, 6000, 0.45, 1);
      [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)].forEach(ax => this.shockRing(c, ax, glow, 4000, 1.0, 0.04, 1));
      this.energyShell(c, glow, 3000, 1.0, 1.3);
      this.streakBurst(c, glow, 400, [2000, 5000], { gravity: 200, life: [0.4, 1.1], width: [10, 22] });
      this.godRays(c, glow.clone().lerp(WHITE, 0.3), 22, 3000, 1.1);
      this.lightFlash(c, glow, 7);
      this.addShake(2.5);
      this.pulseBloom(2);
    });
    this.pulseBloom(0.5);
  }

  // ---------------- 6. Shattered: a wall of crystal forms over the goal and explodes into shards ----------------
  function shattered(pos, team, n) {
    const tint = glowOf(team), T = 2.8, center = pos.clone().setY(340).addScaledVector(n, 120);
    const shardGeo = new THREE.BufferGeometry().setFromPoints([V(-0.5, -0.4, 0), V(0.55, -0.3, 0), V(0.05, 0.6, 0)]);
    shardGeo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: tint, metalness: 0.6, roughness: 0.05, transparent: true, opacity: 0.8, side: THREE.DoubleSide, emissive: tint, emissiveIntensity: 0.35 });
    const list = [];
    for (let i = 0; i < 220; i++) {
      const p = center.clone().add(V(rand(-900, 900), rand(-320, 320), 0));
      const out = p.clone().sub(center).setZ(0).normalize().multiplyScalar(rand(300, 900)).addScaledVector(n, rand(900, 2600)).add(V(0, rand(200, 900), 0));
      list.push(Object.assign(bouncer(p, out, 10), { scale: rand(60, 170), home: p.clone() }));
    }
    const mesh = new THREE.InstancedMesh(shardGeo, mat, list.length), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V(1, 1, 1);
    mesh.frustumCulled = false;
    const burstAt = 0.7;
    let burst = false;
    this.meshFor(mesh, T, (k, t, dt) => {
      if (t > burstAt && !burst) {
        burst = true;
        this.burstFlash(center, WHITE, 4500, 0.35, 1);
        this.shockRing(center, n, tint, 3000, 0.7, 0.05, 1);
        this.streakBurst(center, WHITE, 200, [1500, 3800], { bias: n, biasAmount: 0.7, gravity: 600, life: [0.3, 0.8], width: [6, 12] });
        this.addShake(1.8);
        this.pulseBloom(1.3);
      }
      list.forEach((b, i) => {
        if (burst) stepBouncer(b, dt, 1200);
        else { b.p.copy(b.home); b.rot.x = Math.sin(t * 3 + i) * 0.1; }
        q.setFromEuler(b.rot);
        s.setScalar(b.scale * smooth(0, 0.5, t) * (1 - smooth(0.8, 1, k)));
        m.compose(b.p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (!burst && Math.random() < 0.3) this.glow.emit(center.x + rand(-900, 900), center.y + rand(-300, 300), center.z, 0, 0, 0, 0.3, rand(20, 40), WHITE, { twinkle: 1 });
    });
    this.later(0.05, () => this.lensFlare(center, tint, 3000, 0.5));
  }

  // ---------------- 7. Gold Rush: a fountain of gold coins and bars ----------------
  function goldRush(pos, team, n, painted) {
    const gold = painted ? team.clone() : new THREE.Color(1, 0.78, 0.25);
    const metal = new THREE.MeshStandardMaterial({ color: gold, metalness: 1, roughness: 0.22, emissive: gold, emissiveIntensity: 0.25 });
    const c = pos.clone().addScaledVector(n, 250).setY(150);
    const coins = [], bars = [];
    for (let i = 0; i < 260; i++) {
      const v = randDir(0.4).addScaledVector(n, 0.6).normalize().multiplyScalar(rand(700, 2200)).add(V(0, rand(300, 1100), 0));
      coins.push(Object.assign(bouncer(c, v, 6), { delay: rand(0, 1.0) }));
    }
    for (let i = 0; i < 26; i++) {
      const v = randDir(0.5).addScaledVector(n, 0.5).normalize().multiplyScalar(rand(500, 1300)).add(V(0, rand(500, 1000), 0));
      bars.push(Object.assign(bouncer(c, v, 20), { delay: rand(0, 0.8) }));
    }
    this.bouncers(new THREE.CylinderGeometry(40, 40, 8, 16).rotateX(Math.PI / 2), metal, coins, 3.6, 1300, true);
    this.bouncers(new THREE.BoxGeometry(150, 40, 70), metal.clone(), bars, 3.6, 1300, true);
    let carry = 0;
    this.addActor((a, dt) => {
      if (a.t > 2.8) return false;
      carry += dt * 90;
      for (; carry >= 1; carry--) { const p = c.clone().add(V(rand(-1500, 1500), rand(0, 1200), n.z * rand(0, 2000))); this.glow.emit(p.x, p.y, p.z, 0, rand(20, 80), 0, rand(0.3, 0.7), rand(24, 48), WHITE, { twinkle: 1 }); }
      return true;
    });
    this.burstFlash(c, gold.clone().lerp(WHITE, 0.4), 3200, 0.4, 1);
    this.godRays(c, gold, 16, 2600, 1.4, n);
    this.lightFlash(c, gold, 5);
    this.addShake(1.4);
    this.pulseBloom(1);
  }

  // ---------------- 8. Toon: cartoon puffs with outlines, spinning stars and a POW! ----------------
  const POW_TEX = (() => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.translate(256, 128);
    g.beginPath();
    for (let i = 0; i < 24; i++) { const r = i % 2 ? 90 : 128, a = (i / 24) * Math.PI * 2; g.lineTo(Math.cos(a) * r * 1.8, Math.sin(a) * r * 0.9); }
    g.closePath();
    g.fillStyle = '#ffd23f'; g.fill(); g.lineWidth = 10; g.strokeStyle = '#111'; g.stroke();
    g.font = 'italic 900 120px Impact, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 14; g.strokeStyle = '#111'; g.strokeText('POW!', 0, 8);
    g.fillStyle = '#ff3b3b'; g.fillText('POW!', 0, 8);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  })();
  function toon(pos, team, n, painted) {
    const col = painted ? team.clone() : team.clone().lerp(WHITE, 0.25), c = pos.clone().addScaledVector(n, 500).setY(350);
    const puffGeo = new THREE.SphereGeometry(1, 20, 14), ink = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide });
    for (let i = 0; i < 16; i++) {
      const fill = new THREE.MeshToonMaterial({ color: i % 3 === 0 ? col : new THREE.Color(0.97, 0.97, 0.97) });
      const g = new THREE.Group(), body = new THREE.Mesh(puffGeo, fill), outline = new THREE.Mesh(puffGeo, ink);
      outline.scale.setScalar(1.08);
      g.add(body, outline);
      const dir = randDir(-0.1).addScaledVector(n, 0.4).normalize(), size = rand(180, 360), start = c.clone().add(dir.clone().multiplyScalar(80));
      this.meshFor(g, 2.2, k => {
        const e = 1 - Math.pow(1 - smooth(0, 0.35, k), 3);
        g.position.copy(start).addScaledVector(dir, 900 * e).add(V(0, 250 * k, 0));
        g.scale.setScalar(size * (0.2 + 0.8 * smooth(0, 0.25, k)) * (1 - smooth(0.8, 1, k)));
      }, true);
    }
    const starGeo = new THREE.ShapeGeometry(new THREE.Shape([...Array(10)].map((_, i) => { const r = i % 2 ? 0.45 : 1, a = (i / 10) * Math.PI * 2 + Math.PI / 2; return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r); })));
    for (let i = 0; i < 18; i++) {
      const star = new THREE.Mesh(starGeo, new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffd23f : 0xffffff, side: THREE.DoubleSide, toneMapped: false }));
      const v = randDir(0.2).addScaledVector(n, 0.5).normalize().multiplyScalar(rand(900, 1800)), p = c.clone();
      this.meshFor(star, 1.8, (k, t, dt) => { v.y -= 900 * dt; p.addScaledVector(v, dt); star.position.copy(p); star.rotation.z += dt * 8; star.lookAt(p.clone().add(n)); star.rotateZ(t * 8); star.scale.setScalar(70 * (1 - smooth(0.7, 1, k))); }, true);
    }
    const pow = new THREE.Sprite(new THREE.SpriteMaterial({ map: POW_TEX, transparent: true, depthTest: false, toneMapped: false }));
    pow.position.copy(c).add(V(0, 700, 0));
    pow.renderOrder = 20;
    this.meshFor(pow, 1.8, k => { const pop = k < 0.15 ? smooth(0, 0.15, k) * 1.25 : 1.25 - 0.25 * smooth(0.15, 0.3, k); pow.scale.set(1800 * pop, 900 * pop, 1); pow.material.opacity = 1 - smooth(0.8, 1, k); pow.material.rotation = Math.sin(k * 20) * 0.08; });
    this.addShake(1.4);
  }

  // ---------------- 9. Force Razor: spinning energy blades slice outward ----------------
  function forceRazor(pos, team, n) {
    const glow = glowOf(team), c = pos.clone().addScaledVector(n, 400).setY(400), T = 1.8;
    const bladeShape = new THREE.Shape();
    bladeShape.absarc(0, 0, 1, 0, Math.PI * 0.75, false);
    bladeShape.absarc(0.25, 0.1, 0.8, Math.PI * 0.75, 0, true);
    const bladeGeo = new THREE.ShapeGeometry(bladeShape, 24);
    for (let layer = 0; layer < 2; layer++) {
      const hub = new THREE.Group();
      hub.position.copy(c);
      hub.lookAt(c.clone().add(layer ? UP : n));
      for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(bladeGeo, additive(i % 2 ? WHITE : glow, 0.9)); b.rotation.z = (i / 6) * Math.PI * 2; hub.add(b); }
      this.meshFor(hub, T, (k, t) => {
        hub.rotation.z += 0.3 * (layer ? -1 : 1);
        const r = 200 + 3200 * Math.pow(k, 0.7);
        hub.scale.setScalar(r);
        hub.children.forEach(b => { b.material.opacity = 0.9 * (1 - smooth(0.5, 1, k)); });
      }, true);
    }
    this.addActor(a => {
      if (a.t > T * 0.6) return false;
      for (let i = 0; i < 6; i++) { const ang = a.t * 18 + i, r = 200 + 3200 * Math.pow(a.t / T, 0.7); const p = c.clone().add(V(Math.cos(ang) * r, Math.sin(ang) * r * 0.2, Math.sin(ang) * r)); this.fx().streaks.emit(p, V(-Math.sin(ang), 0, Math.cos(ang)).multiplyScalar(2500), glow, 0.18, { width: 20, stretch: 0.04 }); }
      return true;
    });
    this.burstFlash(c, WHITE, 3600, 0.35, 1);
    this.shockRing(V(c.x, 8, c.z), UP, glow, 4200, 1.0, 0.03, 1);
    this.energyShell(c, glow, 1800, 0.6, 1);
    this.lightFlash(c, glow, 6);
    this.addShake(2);
    this.pulseBloom(1.6);
  }

  // ---------------- 10. Ballistic: a missile barrage lands on the goal ----------------
  function ballistic(pos, team, n) {
    const glow = glowOf(team), fire = new THREE.Color(1, 0.55, 0.15);
    const body = new THREE.MeshStandardMaterial({ color: 0x5b6150, metalness: 0.5, roughness: 0.5 }), tipMat = new THREE.MeshStandardMaterial({ color: team, emissive: glow, emissiveIntensity: 0.4 });
    for (let i = 0; i < 9; i++) {
      this.later(i * 0.15, () => {
        const target = V(pos.x * 0.4 + rand(-1100, 1100), 0, pos.z + n.z * rand(300, 1600));
        const start = target.clone().add(V(rand(-3000, 3000), 2600, n.z * rand(3000, 5000)));
        const missile = new THREE.Group();
        missile.add(new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 220, 10).rotateX(Math.PI / 2), body));
        const tip = new THREE.Mesh(new THREE.ConeGeometry(22, 70, 10).rotateX(Math.PI / 2).translate(0, 0, 145), tipMat);
        missile.add(tip);
        const dur = rand(0.7, 0.95), mid = start.clone().lerp(target, 0.5).add(V(0, 1500, 0));
        let exploded = false;
        this.meshFor(missile, dur + 0.05, (k) => {
          if (exploded) return;
          const u = Math.min(k * (dur + 0.05) / dur, 1);
          const p = start.clone().multiplyScalar((1 - u) * (1 - u)).add(mid.clone().multiplyScalar(2 * u * (1 - u))).add(target.clone().multiplyScalar(u * u));
          const ahead = u < 1 ? start.clone().multiplyScalar((1 - u - 0.01) ** 2).add(mid.clone().multiplyScalar(2 * (u + 0.01) * (1 - u - 0.01))).add(target.clone().multiplyScalar((u + 0.01) ** 2)) : target;
          missile.position.copy(p);
          missile.lookAt(ahead);
          this.glow.emit(p.x, p.y, p.z, rand(-40, 40), rand(-40, 40), rand(-40, 40), rand(0.15, 0.3), rand(40, 70), fire, { grow: -0.5 });
          this.smoke.emit(p.x, p.y, p.z, rand(-40, 40), rand(0, 60), rand(-40, 40), rand(1.0, 1.8), rand(60, 120), new THREE.Color(0.75, 0.75, 0.75), { grow: 2.5, drag: 1, opacity: 0.35 });
          if (u >= 1) {
            exploded = true;
            missile.visible = false;
            const q = target.clone().setY(80);
            this.burstFlash(q, fire.clone().lerp(WHITE, 0.4), 1600, 0.3, 1);
            for (let j = 0; j < 60; j++) { const d = randDir(0).multiplyScalar(rand(200, 900)); this.glow.emit(q.x, q.y, q.z, d.x, d.y, d.z, rand(0.4, 0.8), rand(60, 140), Math.random() < 0.5 ? fire : glow, { drag: 2, grow: -0.3, opacity: 0.9 }); }
            for (let j = 0; j < 12; j++) this.smoke.emit(q.x, q.y + 100, q.z, rand(-200, 200), rand(200, 600), rand(-200, 200), rand(1.5, 2.6), rand(180, 320), new THREE.Color(0.12, 0.11, 0.1), { grow: 2.2, drag: 1.2, gravity: -80, opacity: 0.55 });
            this.shockRing(V(q.x, 8, q.z), UP, fire, 900, 0.5, 0.15, 0.9);
            this.floorScorch(q.x, q.z, fire, 500, 2.5);
            this.addShake(0.6);
            this.pulseBloom(0.25);
          }
        });
      });
    }
    this.later(1.55, () => {
      const q = pos.clone().addScaledVector(n, 700).setY(300);
      this.burstFlash(q, WHITE, 5500, 0.5, 1);
      this.energyShell(q, fire, 2800, 0.9, 1.1);
      this.streakBurst(q, fire, 300, [1500, 4200], { gravity: 900, life: [0.5, 1.3], width: [10, 24] });
      for (let j = 0; j < 40; j++) this.smoke.emit(q.x + rand(-400, 400), q.y + rand(0, 500), q.z + rand(-300, 300), rand(-300, 300), rand(300, 900), rand(-300, 300), rand(2.2, 3.5), rand(300, 520), new THREE.Color(0.1, 0.09, 0.09), { grow: 2.4, drag: 1, gravity: -120, opacity: 0.55 });
      this.shockRing(V(q.x, 8, q.z), UP, fire, 4800, 1.3, 0.05, 1);
      this.lightFlash(q, fire, 7);
      this.addShake(2.8);
      this.pulseBloom(1.8);
    });
  }

  // ---------------- 11. Poly Pop: bright low-poly shapes burst out and pop into smaller ones ----------------
  function polyPop(pos, team, n, painted) {
    const palette = painted ? [team, team.clone().offsetHSL(0, 0, 0.15), team.clone().offsetHSL(0.05, 0, 0)] : [0xff3b6b, 0xffc93c, 0x3ddc97, 0x3aa0ff, 0xb05cff, 0xff8a2b].map(h => new THREE.Color(h));
    const geos = [new THREE.IcosahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0), new THREE.TetrahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0)];
    const c = pos.clone().addScaledVector(n, 300).setY(300);
    const burst = (origin, count, speed, size, generation) => {
      for (let i = 0; i < count; i++) {
        const shape = new THREE.Mesh(geos[i % geos.length], new THREE.MeshStandardMaterial({ color: palette[i % palette.length], flatShading: true, roughness: 0.4, emissive: palette[i % palette.length], emissiveIntensity: 0.35 }));
        const v = randDir(-0.2).addScaledVector(n, 0.4).normalize().multiplyScalar(rand(speed * 0.5, speed)), p = origin.clone(), spin = randDir().multiplyScalar(6);
        const life = generation ? rand(0.9, 1.3) : rand(0.6, 0.9);
        this.meshFor(shape, life, (k, t, dt) => {
          v.y -= 700 * dt; v.multiplyScalar(1 - 0.8 * dt);
          p.addScaledVector(v, dt);
          shape.position.copy(p);
          shape.rotation.x += spin.x * dt; shape.rotation.y += spin.y * dt;
          shape.scale.setScalar(size * (generation ? 1 - smooth(0.7, 1, k) : 0.4 + 0.6 * smooth(0, 0.2, k)));
          if (k >= 1 && !generation) {
            this.burstFlash(p, palette[i % palette.length], size * 5, 0.2, 0.9);
            for (let j = 0; j < 16; j++) this.confetti.emit(p, randDir().multiplyScalar(rand(200, 600)), palette[(i + j) % palette.length], rand(16, 26), rand(1.5, 2.5), { gravity: 300, drag: 1.5, spin: 10, flutter: 120 });
            burst(p, 4, 700, size * 0.4, 1);
            if (this.onPop && Math.random() < 0.4) this.onPop(p.clone());
          }
        }, true);
      }
    };
    burst(c, 22, 2200, 150, 0);
    this.burstFlash(c, WHITE, 3000, 0.3, 0.9);
    this.shockRing(V(c.x, 8, c.z), UP, palette[0], 3000, 0.9, 0.08, 0.8);
    this.addShake(1.4);
    this.pulseBloom(1);
  }

  // ---------------- 12. Sub-Zero: ice spikes erupt from the floor and shatter ----------------
  function subZero(pos, team, n, painted) {
    const ice = painted ? team.clone().lerp(WHITE, 0.3) : new THREE.Color(0.65, 0.9, 1), c = pos.clone().addScaledVector(n, 500).setY(0), T = 2.6;
    const iceMat = new THREE.MeshPhysicalMaterial({ color: ice, roughness: 0.05, metalness: 0.1, transmission: 0, transparent: true, opacity: 0.85, clearcoat: 1, emissive: ice, emissiveIntensity: 0.25, flatShading: true });
    const spikeGeo = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0);
    const spikes = [];
    for (let i = 0; i < 38; i++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 1700;
      spikes.push({ p: c.clone().add(V(Math.cos(a) * r, 0, Math.sin(a) * r * 0.8)), h: rand(400, 1400) * (1 - r / 2600), w: rand(60, 150), tilt: V(rand(-0.35, 0.35), 0, rand(-0.35, 0.35)), delay: r / 1700 * 0.4 });
    }
    const mesh = new THREE.InstancedMesh(spikeGeo, iceMat, spikes.length), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = V(1, 1, 1);
    mesh.frustumCulled = false;
    let shattered = false;
    this.meshFor(mesh, T, (k, t) => {
      spikes.forEach((sp, i) => {
        const grow = shattered ? 0 : 1 - Math.pow(1 - smooth(sp.delay, sp.delay + 0.25, t), 3);
        q.setFromEuler(e.set(sp.tilt.x, 0, sp.tilt.z));
        s.set(sp.w * grow + 0.01, sp.h * grow + 0.01, sp.w * grow + 0.01);
        m.compose(sp.p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (!shattered && t > 1.7) {
        shattered = true;
        this.burstFlash(c.clone().setY(400), WHITE, 4200, 0.35, 1);
        spikes.forEach(sp => { for (let j = 0; j < 6; j++) { const p = sp.p.clone().add(V(0, rand(0, sp.h), 0)); this.voxels.emit(p, randDir(0).multiplyScalar(rand(300, 1400)), ice, rand(20, 45), rand(0.8, 1.4), { gravity: 1300, drag: 0.4, shrink: true, spin: 10 }); } });
        this.streakBurst(c.clone().setY(300), WHITE, 200, [1200, 3000], { gravity: 800, life: [0.3, 0.8], width: [6, 12] });
        this.addShake(1.8);
        this.pulseBloom(1.2);
      }
    });
    for (let i = 0; i < 70; i++) this.smoke.emit(c.x + rand(-1600, 1600), rand(20, 200), c.z + rand(-1300, 1300), rand(-100, 100), rand(20, 120), rand(-100, 100), rand(2.0, 3.2), rand(250, 480), new THREE.Color(0.9, 0.96, 1), { grow: 1.6, drag: 1, opacity: 0.35 });
    this.shockRing(V(c.x, 8, c.z), UP, ice, 2600, 0.8, 0.12, 1);
    this.floorScorch(c.x, c.z, ice, 2200, 3.2);
    this.lightFlash(c.clone().setY(300), ice, 4);
    this.addShake(1.2);
    this.pulseBloom(0.8);
  }

  // ---------------- 13. Solar Flare: a miniature sun with plasma loops ----------------
  function solarFlare(pos, team, n, painted) {
    const sun = painted ? glowOf(team) : new THREE.Color(1, 0.6, 0.15), c = pos.clone().addScaledVector(n, 700).setY(700), T = 2.5;
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: sun }, fade: { value: 1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vP; varying vec3 vV; void main() { vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
      fragmentShader: NOISE + `uniform float time; uniform vec3 color; uniform float fade; varying vec3 vN; varying vec3 vP; varying vec3 vV;
        void main() { float f = fbm3(vP * 3.0 + vec3(time * 0.8, time * 0.5, 0.0));
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          vec3 col = mix(color * 1.4, vec3(1.0, 0.95, 0.75), smoothstep(0.45, 0.8, f)) * (1.2 + rim * 2.0);
          gl_FragColor = vec4(col * fade, 1.0); }`
    });
    const star = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
    star.position.copy(c);
    this.meshFor(star, T, (k, t) => { mat.uniforms.time.value = t; star.scale.setScalar(420 * smooth(0, 0.2, k) * (1 + 0.05 * Math.sin(t * 12)) * (1 - smooth(0.85, 0.92, k))); });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2, axis = V(Math.cos(a), rand(-0.3, 0.3), Math.sin(a)).normalize();
      const pts = [];
      for (let j = 0; j <= 20; j++) { const u = j / 20 * Math.PI; pts.push(axis.clone().multiplyScalar(Math.cos(u) * 1.25).add(V(0, Math.sin(u) * 0.9 + 0.2, 0)).multiplyScalar(420)); }
      const loop = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 26, 8, false), additive(sun.clone().lerp(WHITE, 0.2), 0.9));
      loop.position.copy(c);
      loop.rotation.y = rand(0, 6);
      this.meshFor(loop, T, (k, t) => { loop.scale.setScalar(smooth(0.15 + i * 0.05, 0.45 + i * 0.05, k) * (1 + 0.3 * k) * (1 - smooth(0.85, 0.9, k)) + 0.001); loop.rotation.y += 0.01; loop.material.opacity = 0.9 * (0.6 + 0.4 * Math.sin(t * 20 + i)); });
    }
    let carry = 0;
    this.addActor((a, dt) => {
      if (a.t > T * 0.85) return false;
      carry += dt * 160;
      for (; carry >= 1; carry--) { const d = randDir(), p = c.clone().addScaledVector(d, 430); this.glow.emit(p.x, p.y, p.z, d.x * 700, d.y * 700, d.z * 700, rand(0.5, 1.0), rand(50, 110), sun, { drag: 1, grow: -0.5 }); }
      return true;
    });
    this.godRays(c, sun, 24, 3200, 2.2);
    this.lensFlare(c, sun, 7000, 2.0);
    this.later(T * 0.87, () => {
      this.burstFlash(c, WHITE, 7000, 0.55, 1);
      this.energyShell(c, sun, 3600, 1.0, 1.4);
      this.streakBurst(c, sun, 380, [1800, 4800], { gravity: 150, life: [0.5, 1.2], width: [12, 26] });
      this.lightFlash(c, sun, 8);
      this.addShake(2.6);
      this.pulseBloom(2.2);
    });
    this.pulseBloom(1);
  }

  // ---------------- 14. Distortion: space glitches and warps, then snaps back ----------------
  function distortion(pos, team, n) {
    const glow = glowOf(team), c = pos.clone().addScaledVector(n, 500).setY(500), T = 2.2;
    const warp = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: glow }, fade: { value: 1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main() { vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
      fragmentShader: NOISE + `uniform float time; uniform vec3 color; uniform float fade; varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() { float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
          float scan = step(0.5, fract(vP.y * 18.0 + time * 6.0));
          float g = step(0.7, n3(floor(vP * 10.0) + vec3(floor(time * 14.0))));
          vec3 col = vec3(color.r * (1.0 + g), color.g, color.b * (1.0 + scan * 0.5));
          gl_FragColor = vec4(col * (rim * 2.0 + g * 0.6) * fade, (rim * 0.9 + g * 0.3) * fade); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const bubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), warp);
    bubble.position.copy(c);
    this.meshFor(bubble, T, (k, t) => { warp.uniforms.time.value = t; const pulse = 1 + 0.15 * Math.sin(t * 25) * (1 - k); bubble.scale.set(1400 * k * pulse, 1100 * k * (2 - pulse), 1400 * k * pulse); warp.uniforms.fade.value = 1 - smooth(0.7, 1, k); });
    // Chromatic split rings
    [[1, 0.1, 0.1], [0.1, 1, 0.2], [0.2, 0.4, 1]].forEach((rgb, i) => this.later(i * 0.05, () => this.shockRing(c.clone().add(V((i - 1) * 40, 0, 0)), n, new THREE.Color(...rgb), 3600, 1.1, 0.04, 1)));
    // Glitch blocks flickering in and out
    this.addActor(a => {
      if (a.t > T) return false;
      for (let i = 0; i < 6; i++) {
        const p = c.clone().add(V(rand(-1600, 1600), rand(-500, 900), rand(-800, 800)));
        const col = [new THREE.Color(1, 0.2, 0.3), new THREE.Color(0.2, 1, 0.9), glow, WHITE][i % 4];
        this.voxels.emit(p, V(rand(-800, 800), 0, 0), col, rand(20, 90), rand(0.06, 0.18), { gravity: 0, drag: 0 });
      }
      return true;
    });
    this.later(T * 0.8, () => {
      this.burstFlash(c, WHITE, 4000, 0.25, 1);
      this.streakBurst(c, glow, 220, [2500, 5000], { gravity: 0, life: [0.2, 0.5], width: [6, 14] });
      this.addShake(2.2);
      this.pulseBloom(1.5);
    });
    this.addShake(1);
  }

  // ---------------- 15. Popcorn: a giant kettle pops corn everywhere ----------------
  function popcorn(pos, team, n, painted) {
    const stripe = painted ? team.clone() : new THREE.Color(0.85, 0.12, 0.15), c = pos.clone().addScaledVector(n, 700).setY(0), T = 3.4;
    const tex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 64;
      const g = cv.getContext('2d');
      for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f4f0e6' : '#' + stripe.getHexString(); g.fillRect(i * 32, 0, 32, 64); }
      const t = new THREE.CanvasTexture(cv);
      t.encoding = THREE.sRGBEncoding;
      return t;
    })();
    const kettle = new THREE.Group();
    kettle.add(new THREE.Mesh(new THREE.CylinderGeometry(520, 420, 900, 32, 1, true).translate(0, 450, 0), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 })));
    const lid = new THREE.Mesh(new THREE.SphereGeometry(540, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.8, roughness: 0.3 }));
    lid.position.y = 900;
    kettle.add(lid);
    kettle.position.copy(c);
    this.meshFor(kettle, T, (k, t) => {
      kettle.position.y = -1000 * (1 - smooth(0, 0.12, k)) - 1200 * smooth(0.9, 1, k);
      kettle.rotation.z = Math.sin(t * 30) * 0.03 * smooth(0.12, 0.2, k);
      lid.position.y = 900 + (t > 0.6 ? 500 * smooth(0.6, 0.8, t) : 0);
      lid.rotation.x = t > 0.6 ? -1.2 * smooth(0.6, 0.8, t) : 0;
    });
    const kernelGeo = new THREE.IcosahedronGeometry(1, 0);
    const posAttr = kernelGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) posAttr.setXYZ(i, posAttr.getX(i) * rand(0.8, 1.25), posAttr.getY(i) * rand(0.8, 1.25), posAttr.getZ(i) * rand(0.8, 1.25));
    kernelGeo.computeVertexNormals();
    const kernelMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, roughness: 0.9, flatShading: true, emissive: 0x332a10 });
    const list = [];
    for (let i = 0; i < 320; i++) {
      const v = randDir(0.5).addScaledVector(n, 0.3).normalize().multiplyScalar(rand(500, 1700)).add(V(0, rand(700, 1600), 0));
      list.push(Object.assign(bouncer(c.clone().setY(1000), v, 25), { delay: 0.7 + Math.pow(Math.random(), 1.6) * 2.0, scale: rand(26, 44) }));
    }
    this.bouncers(kernelGeo, kernelMat, list, T, 1400, true);
    let popped = 0;
    const order = list.map(k => k.delay).sort((x, y) => x - y);
    this.addActor(a => {
      if (a.t > 2.7) return false;
      while (popped < order.length && a.t > order[popped]) {
        if (popped % 12 === 0) { const p = c.clone().setY(1100); this.burstFlash(p, new THREE.Color(1, 0.95, 0.8), 500, 0.12, 0.6); if (this.onPop) this.onPop(p); }
        popped++;
      }
      return true;
    });
    for (let i = 0; i < 20; i++) this.later(0.7 + i * 0.1, () => this.smoke.emit(c.x, 1100, c.z, rand(-100, 100), rand(200, 500), rand(-100, 100), rand(1.2, 2), rand(150, 260), new THREE.Color(0.95, 0.95, 0.92), { grow: 2, drag: 1.2, opacity: 0.3 }));
    this.addShake(1);
    this.pulseBloom(0.4);
  }

  // ---------------- 16. Mushroom Cloud: a rising fireball rolls into a mushroom cloud ----------------
  function mushroomCloud(pos, team, n, painted) {
    const fire = painted ? glowOf(team) : new THREE.Color(1, 0.5, 0.12), c = pos.clone().addScaledVector(n, 700).setY(0), T = 3.6, dark = painted && isDark(team);
    this.burstFlash(c.clone().setY(400), WHITE, 9000, 0.6, 1);
    this.lightFlash(c.clone().setY(600), fire, 9);
    this.shockRing(V(c.x, 10, c.z), UP, fire.clone().lerp(WHITE, 0.4), 7000, 1.8, 0.03, 1);
    this.later(0.1, () => this.shockRing(V(c.x, 10, c.z), UP, WHITE, 5000, 1.3, 0.02, 0.8));
    this.floorScorch(c.x, c.z, fire, 2600, 4.5);
    this.energyShell(c.clone().setY(300), fire, 2600, 0.8, 1.2);
    let carry = 0;
    this.addActor((a, dt) => {
      const t = a.t;
      if (t > T) return false;
      const rise = 400 + 2400 * (1 - Math.exp(-t * 1.4));
      carry += dt * 260;
      for (; carry >= 1; carry--) {
        if (Math.random() < 0.45) {
          // Stem
          const y = rand(0, rise * 0.9), r = 220 + y * 0.08;
          const heat = 1 - y / rise;
          this.smoke.emit(c.x + rand(-r, r), y, c.z + rand(-r, r), rand(-40, 40), rand(250, 500), rand(-40, 40), rand(0.8, 1.4), rand(180, 300),
            new THREE.Color(0.18, 0.14, 0.12).lerp(fire, heat * 0.35), { grow: 1.2, drag: 1.5, opacity: 0.55 });
        } else {
          // Cap: a rolling torus of smoke lit orange from below
          const ang = rand(0, Math.PI * 2), tube = rand(0, Math.PI * 2), R = 700 + t * 250, rr = 280 + t * 90;
          const p = V(c.x + Math.cos(ang) * (R + Math.cos(tube) * rr), rise + Math.sin(tube) * rr, c.z + Math.sin(ang) * (R + Math.cos(tube) * rr));
          const lit = Math.sin(tube) < 0 ? fire.clone().multiplyScalar(0.9) : new THREE.Color(0.22, 0.18, 0.16);
          this.smoke.emit(p.x, p.y, p.z, Math.cos(ang) * 80, Math.cos(tube) * 120, Math.sin(ang) * 80, rand(0.8, 1.5), rand(260, 420), lit, { grow: 1, drag: 1.2, opacity: 0.6 });
        }
        if (Math.random() < 0.3 && t < 1.6) this.paintEmit(dark, c.x + rand(-300, 300), rise * rand(0.7, 1.0), c.z + rand(-300, 300), rand(-200, 200), rand(100, 400), rand(-200, 200), rand(0.4, 0.8), rand(200, 380), fire, { grow: -0.2, drag: 1.5, opacity: 0.85 });
      }
      return true;
    });
    this.streakBurst(c.clone().setY(200), fire, 260, [1500, 3500], { minY: 0.1, gravity: 900, life: [0.6, 1.4], width: [10, 22] });
    this.godRays(c.clone().setY(600), fire, 16, 3500, 1.8, UP);
    this.addShake(3);
    this.pulseBloom(2.2);
  }

  // ---------------- registry ----------------
  const EXTRA = [
    ['singularity', 'Singularity', 'Black Market', 'A black hole opens over the goal, swallows the light around it and detonates.', singularity],
    ['meteorStorm', 'Meteor Storm', 'Exotic', 'Flaming meteors rain down on the goal and scorch the pitch.', meteorStorm],
    ['neuroAgitator', 'Neuro-Agitator', 'Black Market', 'Tesla coils rise from the floor and arc lightning into an overcharged core.', neuroAgitator],
    ['bigSplash', 'Big Splash', 'Exotic', 'A towering wave of water erupts out of the goal.', bigSplash],
    ['atomizer', 'Atomizer', 'Black Market', 'Electrons whirl around a glowing nucleus until it splits apart.', atomizer],
    ['shattered', 'Shattered', 'Exotic', 'A wall of crystal forms over the goal and explodes into shards.', shattered],
    ['goldRush', 'Gold Rush', 'Black Market', 'A fountain of gold coins and bars that bounce across the field.', goldRush],
    ['toon', 'Toon', 'Import', 'A cartoon blast: outlined puff clouds, spinning stars and a big POW!', toon],
    ['forceRazor', 'Force Razor', 'Black Market', 'Spinning energy blades slice out across the pitch.', forceRazor],
    ['ballistic', 'Ballistic', 'Exotic', 'A missile barrage streaks in and levels the goal.', ballistic],
    ['polyPop', 'Poly Pop', 'Import', 'Bright low-poly shapes burst out and pop into smaller ones.', polyPop],
    ['subZero', 'Sub-Zero', 'Black Market', 'Ice spikes erupt from the floor in a frozen mist, then shatter.', subZero],
    ['solarFlare', 'Solar Flare', 'Black Market', 'A miniature sun flares up with plasma loops, then goes supernova.', solarFlare],
    ['distortion', 'Distortion', 'Exotic', 'Space glitches and warps with split colours, then snaps back.', distortion],
    ['popcorn', 'Popcorn', 'Import', 'A giant kettle rises and pops corn all over the field.', popcorn],
    ['mushroomCloud', 'Mushroom Cloud', 'Black Market', 'A blinding fireball rolls up into a towering mushroom cloud.', mushroomCloud]
  ];
  const handlers = {};
  EXTRA.forEach(([id, name, rarity, desc, fn]) => { E.EXPLOSIONS.push({ id, name, rarity, desc }); handlers[id] = fn; });

  const baseGoal = P.goalExplosion;
  P.goalExplosion = function (pos, teamHex, type, paintHex) {
    const fn = handlers[type];
    if (!fn) return baseGoal.call(this, pos, teamHex, type, paintHex);
    const painted = paintHex !== null && paintHex !== undefined;
    const team = new THREE.Color(painted ? paintHex : teamHex);
    const n = V(0, 0, pos.z > 0 ? -1 : 1);
    fn.call(this, pos.clone(), team, n, painted);
  };
})();
