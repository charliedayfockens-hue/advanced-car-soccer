// Particle effects rebuilt to look like Rocket League's (standard and alpha boost, supersonic wind trail,
// ball hits, boost pickups, demolitions, flip reset) and the goal explosions: Classic, Party Time,
// Fireworks, Hellfire, Dueling Dragons and Voxel. Nothing is taken from the game; each is recreated from how
// it looks. Camera shake included. Everything is in three.js world space (uu).
window.Game = window.Game || {};

Game.Effects = (function () {
  const VERT = `
    attribute float size;
    attribute float alpha;
    attribute vec3 pcolor;
    uniform float scale;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vAlpha = alpha;
      vColor = pcolor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * scale / max(-mv.z, 1.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const FRAG = `
    uniform float soft;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = pow(1.0 - d * 2.0, soft);
      gl_FragColor = vec4(vColor, a * vAlpha);
    }`;

  // Round point sprites (glow is additive, smoke is normal blending)
  class Particles {
    constructor(scene, cap, additive) {
      this.cap = cap;
      this.next = 0;
      this.pos = new Float32Array(cap * 3);
      this.vel = new Float32Array(cap * 3);
      this.col = new Float32Array(cap * 3);
      this.size = new Float32Array(cap);
      this.alpha = new Float32Array(cap);
      this.life = new Float32Array(cap);
      this.maxLife = new Float32Array(cap);
      this.base = new Float32Array(cap);
      this.grow = new Float32Array(cap);
      this.drag = new Float32Array(cap);
      this.grav = new Float32Array(cap);
      this.opacity = new Float32Array(cap);
      this.twinkle = new Float32Array(cap);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
      this.geo = geo;
      this.material = new THREE.ShaderMaterial({
        uniforms: { scale: { value: 500 }, soft: { value: additive ? 1.6 : 1.0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
      });
      const points = new THREE.Points(geo, this.material);
      points.frustumCulled = false;
      points.renderOrder = additive ? 5 : 4;
      scene.add(points);
    }

    emit(px, py, pz, vx, vy, vz, life, size, color, o) {
      const i = this.next;
      this.next = (i + 1) % this.cap;
      const i3 = i * 3;
      this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
      this.life[i] = this.maxLife[i] = life;
      this.base[i] = size;
      this.grow[i] = o && o.grow !== undefined ? o.grow : 0;
      this.drag[i] = o && o.drag !== undefined ? o.drag : 0;
      this.grav[i] = o && o.gravity !== undefined ? o.gravity : 0;
      this.opacity[i] = o && o.opacity !== undefined ? o.opacity : 1;
      this.twinkle[i] = o && o.twinkle ? 1 : 0;
    }

    update(dt) {
      for (let i = 0; i < this.cap; i++) {
        if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
        const i3 = i * 3, k = Math.max(0, 1 - this.drag[i] * dt);
        this.vel[i3] *= k; this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt; this.vel[i3 + 2] *= k;
        this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        const t = 1 - this.life[i] / this.maxLife[i];
        this.alpha[i] = Math.pow(1 - t, 1.4) * this.opacity[i];
        if (this.twinkle[i]) this.alpha[i] *= 0.3 + 0.7 * Math.abs(Math.sin(this.life[i] * 38 + i));
        this.size[i] = this.base[i] * (1 + this.grow[i] * t);
      }
      const a = this.geo.attributes;
      a.position.needsUpdate = a.pcolor.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = true;
    }
  }

  const tmpV = new THREE.Vector3(), tmpC = new THREE.Color();
  const rand = (a, b) => a + Math.random() * (b - a);
  // Dark paints (black, burnt sienna) vanish with additive blending, so they're drawn with normal blending instead
  const isDark = c => Math.max(c.r, c.g, c.b) < 0.5;
  const paintPalette = c => [c, c.clone().offsetHSL(0, 0, 0.15), c.clone().offsetHSL(0, 0, -0.12), c.clone().lerp(new THREE.Color(1, 1, 1), 0.55), c];
  const UP = new THREE.Vector3(0, 1, 0);
  const WHITE = new THREE.Color(1, 1, 1);

  // Instanced solid pieces: confetti (spinning, fluttering) and voxels (axis-aligned, shrinking)
  class Pieces {
    constructor(scene, geometry, material, cap) {
      this.cap = cap;
      this.next = 0;
      this.items = new Array(cap).fill(null);
      this.mesh = new THREE.InstancedMesh(geometry, material, cap);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.e = new THREE.Euler();
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) { this.mesh.setMatrixAt(i, hidden); this.mesh.setColorAt(i, WHITE); }
      scene.add(this.mesh);
      this.alive = 0;
    }

    emit(pos, vel, color, size, life, o) {
      o = o || {};
      const i = this.next;
      this.next = (i + 1) % this.cap;
      this.items[i] = {
        p: pos.clone(), v: vel.clone(), size, life, max: life, grav: o.gravity || 0, drag: o.drag || 0,
        spin: o.spin ? new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(o.spin) : null,
        rot: new THREE.Vector3(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)), shrink: !!o.shrink, stretch: o.stretch || 1, flutter: o.flutter || 0
      };
      this.mesh.setColorAt(i, color);
      this.mesh.instanceColor.needsUpdate = true;
      this.alive++;
    }

    update(dt) {
      if (!this.alive) return;
      let alive = 0;
      for (let i = 0; i < this.cap; i++) {
        const it = this.items[i];
        if (!it) continue;
        it.life -= dt;
        if (it.life <= 0) { this.items[i] = null; this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)); continue; }
        alive++;
        const k = Math.max(0, 1 - it.drag * dt);
        it.v.x *= k; it.v.z *= k; it.v.y = it.v.y * k - it.grav * dt;
        if (it.flutter) { it.v.x += Math.sin(it.life * 9 + i) * it.flutter * dt; it.v.z += Math.cos(it.life * 7 + i) * it.flutter * dt; }
        it.p.addScaledVector(it.v, dt);
        if (it.spin) { it.rot.addScaledVector(it.spin, dt); this.q.setFromEuler(this.e.set(it.rot.x, it.rot.y, it.rot.z)); } else this.q.identity();
        const t = 1 - it.life / it.max;
        const sc = it.size * (it.shrink ? Math.max(0.05, 1 - t * t) : Math.min(1, it.life / 0.3));
        this.m.compose(it.p, this.q, this.s.set(sc * it.stretch, sc, sc));
        this.mesh.setMatrixAt(i, this.m);
      }
      this.alive = alive;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Soft round glow for flashes, dragon heads and pops
  const GLOW_TEX = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.22, 'rgba(255,255,255,0.8)');
    r.addColorStop(0.55, 'rgba(255,255,255,0.2)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();

  const BALLOON_GEO = new THREE.SphereGeometry(70, 20, 16);
  const KNOT_GEO = new THREE.ConeGeometry(11, 18, 8).rotateX(Math.PI);
  const STRING_GEO = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, -90, 0), new THREE.Vector3(-6, -190, 0)]);
  const STRING_MAT = new THREE.LineBasicMaterial({ color: 0xe8e8e8, transparent: true, opacity: 0.7 });
  const PARTY = [0xff3b6b, 0xffc93c, 0x3ddc97, 0x3aa0ff, 0xb05cff, 0xff8a2b, 0xffffff].map(h => new THREE.Color(h));

  // Ribbon trail styles
  const ALPHA_TRAIL = { color: new THREE.Color(1.0, 0.55, 0.08), core: new THREE.Color(1.0, 0.95, 0.7), life: 0.35, width: 9, max: 48 };
  const SONIC_TRAIL = { color: new THREE.Color(0.7, 0.85, 1.0), core: new THREE.Color(1, 1, 1), life: 0.5, width: 4.5, max: 60 };

  const EXPLOSIONS = [
    { id: 'classic', name: 'Classic', rarity: 'Default', desc: 'A blinding flash, a team-coloured blast and a shockwave across the pitch.' },
    { id: 'partyTime', name: 'Party Time', rarity: 'Black Market', desc: 'Party poppers and confetti, then balloons that float to the roof and pop.' },
    { id: 'fireworks', name: 'Fireworks', rarity: 'Import', desc: 'Rockets launch from the goal and chain into firework bursts.' },
    { id: 'hellfire', name: 'Hellfire', rarity: 'Black Market', desc: 'A horned demon skull of molten lava rises from a cracked crater, roars fire and hurls meteors.' },
    { id: 'dragons', name: 'Dueling Dragons', rarity: 'Black Market', desc: 'Two winged dragons burst from a portal, spiral up breathing fire and clash in the sky.' },
    { id: 'voxel', name: 'Voxel', rarity: 'Black Market', desc: 'Blocky pixel fire bursts out, half of it in your team colour.' }
  ];

  // Rocket League's paint colours, red through black. Unpainted uses the scorer's team colour.
  const PAINTS = [
    { id: 'unpainted', name: 'Team Colour', hex: null },
    { id: 'crimson', name: 'Crimson', hex: 0xd41c1c },
    { id: 'orange', name: 'Orange', hex: 0xff7a00 },
    { id: 'saffron', name: 'Saffron', hex: 0xf2d000 },
    { id: 'lime', name: 'Lime', hex: 0x7ee81c },
    { id: 'forestGreen', name: 'Forest Green', hex: 0x2f8f3a },
    { id: 'skyBlue', name: 'Sky Blue', hex: 0x3cc8ff },
    { id: 'cobalt', name: 'Cobalt', hex: 0x3a4ddc },
    { id: 'purple', name: 'Purple', hex: 0x8b2de0 },
    { id: 'pink', name: 'Pink', hex: 0xff55b8 },
    { id: 'burntSienna', name: 'Burnt Sienna', hex: 0x7a3b1d },
    { id: 'grey', name: 'Grey', hex: 0x8a8a8a },
    { id: 'titaniumWhite', name: 'Titanium White', hex: 0xffffff },
    { id: 'black', name: 'Black', hex: 0x0d0d0d }
  ];

  class Effects {
    constructor(scene) {
      this.scene = scene;
      this.glow = new Particles(scene, 7000, true);
      this.smoke = new Particles(scene, 1400, false);
      this.ink = new Particles(scene, 3000, false); // dark-paint explosion particles
      this.ink.material.uniforms.soft.value = 1.6;
      this.confetti = new Pieces(scene, new THREE.PlaneGeometry(1, 0.62), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 1800);
      this.voxels = new Pieces(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), 1200);
      this.rings = [];
      this.actors = [];
      this.shake = 0;
      this.light = new THREE.PointLight(0xffffff, 0, 6000, 2);
      scene.add(this.light);
      this.carries = new Map();
      this.trails = new Map();
      this.onPop = null;       // (pos) balloon popped
      this.onFirework = null;  // (pos, generation) firework shell burst
    }

    setViewportHeight(h, fov) {
      const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
      this.glow.material.uniforms.scale.value = scale;
      this.smoke.material.uniforms.scale.value = scale;
      this.ink.material.uniforms.scale.value = scale;
    }

    // ---------------- building blocks ----------------
    addActor(update) { this.actors.push({ t: 0, update }); }

    // Glow particle in a paint colour: additive normally, normal-blended when the paint is too dark to add light
    paintEmit(dark, px, py, pz, vx, vy, vz, life, size, color, o) {
      (dark ? this.ink : this.glow).emit(px, py, pz, vx, vy, vz, life, size, color, o);
    }

    burstFlash(pos, color, size, dur, peak) {
      const mat = new THREE.SpriteMaterial({ map: GLOW_TEX, color, transparent: true, blending: isDark(color) ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const s = new THREE.Sprite(mat);
      s.position.copy(pos);
      s.renderOrder = 7;
      this.scene.add(s);
      this.addActor(a => {
        const k = Math.min(a.t / dur, 1);
        const sc = size * (0.35 + 0.65 * Math.sqrt(k));
        s.scale.set(sc, sc, 1);
        mat.opacity = (peak === undefined ? 1 : peak) * (1 - k) * (1 - k);
        if (k >= 1) { this.scene.remove(s); mat.dispose(); return false; }
        return true;
      });
    }

    shockRing(pos, normal, color, max, dur, width, opacity) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opacity === undefined ? 1 : opacity, blending: isDark(color) ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(1 - (width || 0.08), 1, 96), mat);
      ring.position.copy(pos);
      ring.lookAt(pos.clone().add(normal));
      this.scene.add(ring);
      this.rings.push({ mesh: ring, t: 0, dur, max, fade: opacity === undefined ? 1 : opacity });
    }

    lightFlash(pos, color, intensity) {
      this.light.color.copy(color);
      this.light.position.copy(pos);
      this.light.intensity = intensity;
    }

    trailState(key, style) {
      let st = this.trails.get(key);
      if (!st) {
        const geo = new THREE.BufferGeometry();
        const max = style.max;
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(max * 2), 1).setUsage(THREE.DynamicDrawUsage));
        const idx = [];
        for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        geo.setIndex(idx);
        const mat = new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          uniforms: { color: { value: style.color }, core: { value: style.core } },
          vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'uniform vec3 color; uniform vec3 core; varying float vA; void main(){ vec3 c = mix(color, core, vA); gl_FragColor = vec4(c * (0.6 + 0.8 * vA), vA * vA * 0.85); }'
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 6;
        this.scene.add(mesh);
        st = { carry: 0, points: [], mesh, max, life: style.life, width: style.width, active: false };
        this.trails.set(key, st);
      }
      return st;
    }

    updateTrails(dt) {
      this.trails.forEach(st => {
        st.points.forEach(pt => { pt.age += dt; });
        while (st.points.length && (st.points.length > st.max || st.points[st.points.length - 1].age > st.life)) st.points.pop();
        if (!st.active && st.points.length) st.points.forEach(pt => { pt.age += dt * 2; });
        st.active = false;
        const pos = st.mesh.geometry.attributes.position, al = st.mesh.geometry.attributes.alpha;
        for (let i = 0; i < st.max; i++) {
          const pt = st.points[Math.min(i, st.points.length - 1)];
          if (!pt) { al.setX(i * 2, 0); al.setX(i * 2 + 1, 0); continue; }
          const life = 1 - Math.min(pt.age / st.life, 1);
          const w = st.width * life + 1.5;
          pos.setXYZ(i * 2, pt.p.x + pt.up.x * w, pt.p.y + pt.up.y * w, pt.p.z + pt.up.z * w);
          pos.setXYZ(i * 2 + 1, pt.p.x - pt.up.x * w, pt.p.y - pt.up.y * w, pt.p.z - pt.up.z * w);
          const a = i < st.points.length ? life : 0;
          al.setX(i * 2, a); al.setX(i * 2 + 1, a);
        }
        pos.needsUpdate = al.needsUpdate = true;
      });
    }

    // ---------------- car effects ----------------
    // Standard boost: orange flame streaks with a hot yellow core and a little smoke
    boost(key, carPos, carQuat, carVel, supersonic, dt) {
      let carry = (this.carries.get(key) || 0) + dt * (supersonic ? 160 : 120);
      const back = tmpV.set(-1, 0, 0).applyQuaternion(carQuat).clone();
      for (; carry >= 1; carry -= 1) {
        [-17, 17].forEach(side => {
          const p = new THREE.Vector3(-58, 15, side).applyQuaternion(carQuat).add(carPos);
          const sp = rand(350, 700);
          const hot = Math.random();
          tmpC.setRGB(1, 0.45 + hot * 0.45, 0.12 + hot * 0.3);
          this.glow.emit(p.x, p.y, p.z,
            carVel.x * 0.4 + back.x * sp + rand(-60, 60), carVel.y * 0.4 + back.y * sp + rand(-60, 60), carVel.z * 0.4 + back.z * sp + rand(-60, 60),
            rand(0.14, 0.26), rand(16, 26), tmpC, { grow: -0.6, drag: 2 });
          if (Math.random() < 0.25) {
            tmpC.setRGB(0.55, 0.58, 0.62);
            this.smoke.emit(p.x, p.y, p.z, back.x * 120 + rand(-30, 30), back.y * 120 + rand(10, 60), back.z * 120 + rand(-30, 30),
              rand(0.5, 0.9), rand(20, 34), tmpC, { grow: 2.5, drag: 1.5, opacity: 0.22 });
          }
        });
      }
      this.carries.set(key, carry);
    }

    // Gold "Alpha" boost: white-hot core, gold flame streaks, a gold ribbon and twinkling glitter
    boostAlpha(key, carPos, carQuat, carVel, supersonic, dt) {
      const st = this.trailState('alpha' + key, ALPHA_TRAIL);
      st.carry += dt * (supersonic ? 190 : 150);
      const back = new THREE.Vector3(-1, 0, 0).applyQuaternion(carQuat);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(carQuat);
      const right = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
      while (st.carry >= 1) {
        st.carry -= 1;
        [-15, 15].forEach(side => {
          const p = new THREE.Vector3(-60, 1, side).applyQuaternion(carQuat).add(carPos);
          const sp = rand(420, 780);
          tmpC.setRGB(1, 0.95, 0.75);
          this.glow.emit(p.x, p.y, p.z, carVel.x * 0.5 + back.x * sp, carVel.y * 0.5 + back.y * sp, carVel.z * 0.5 + back.z * sp,
            rand(0.07, 0.12), rand(14, 20), tmpC, { grow: -0.7, drag: 3 });
          tmpC.setRGB(1, rand(0.55, 0.75), rand(0.08, 0.2));
          this.glow.emit(p.x, p.y, p.z, carVel.x * 0.35 + back.x * sp * 0.8 + rand(-40, 40), carVel.y * 0.35 + back.y * sp * 0.8 + rand(-40, 40), carVel.z * 0.35 + back.z * sp * 0.8 + rand(-40, 40),
            rand(0.18, 0.3), rand(18, 28), tmpC, { grow: -0.5, drag: 2.2 });
          if (Math.random() < 0.55) {
            const a = Math.random() * Math.PI * 2, r = rand(40, 160);
            const v = right.clone().multiplyScalar(Math.cos(a) * r).add(up.clone().multiplyScalar(Math.sin(a) * r)).addScaledVector(back, rand(80, 260));
            tmpC.setRGB(1, rand(0.78, 0.92), rand(0.35, 0.55));
            this.glow.emit(p.x, p.y, p.z, carVel.x * 0.15 + v.x, carVel.y * 0.15 + v.y, carVel.z * 0.15 + v.z,
              rand(0.6, 1.1), rand(5, 9), tmpC, { drag: 2.5, gravity: 60, twinkle: 1 });
          }
        });
      }
      const exhaust = new THREE.Vector3(-58, 2, 0).applyQuaternion(carQuat).add(carPos);
      st.points.unshift({ p: exhaust, up: up.clone(), age: 0 });
      st.active = true;
    }

    // Supersonic: thin white wind trails streaming from the rear corners of the car
    supersonic(key, carPos, carQuat, active) {
      if (!active) return;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(carQuat);
      [-1, 1].forEach(side => {
        const st = this.trailState('sonic' + side + '_' + key, SONIC_TRAIL);
        const p = new THREE.Vector3(-46, -6, side * 38).applyQuaternion(carQuat).add(carPos);
        st.points.unshift({ p, up: up.clone(), age: 0 });
        st.active = true;
      });
    }

    // Ball hit: a quick bright flash at the contact, sparks off the ball and a ripple on hard hits
    ballHit(pos, strength, normal) {
      const k = Math.min(strength / 3000, 1);
      const n = normal ? normal.clone().normalize() : UP.clone();
      this.burstFlash(pos, new THREE.Color(0.85, 0.93, 1), 90 + 420 * k, 0.14, 0.55 + 0.45 * k);
      const count = Math.round(6 + k * 44);
      for (let i = 0; i < count; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
        if (d.dot(n) < 0) d.addScaledVector(n, -1.8 * d.dot(n));
        d.normalize().multiplyScalar(rand(300, 600 + 1400 * k));
        tmpC.setRGB(rand(0.85, 1), rand(0.92, 1), 1);
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.18, 0.42), rand(6, 14), tmpC, { drag: 2.8, gravity: 650 });
      }
      if (k > 0.45) this.shockRing(pos, n, new THREE.Color(0.8, 0.9, 1), 180 + 520 * k, 0.32, 0.12, 0.7);
      this.addShake(0.1 + k * 0.5);
    }

    // Boost pad pickup: a pop of light and embers rising off the pad
    boostPickup(pos, big) {
      this.burstFlash(new THREE.Vector3(pos.x, pos.y + 30, pos.z), new THREE.Color(1, 0.7, 0.25), big ? 460 : 200, 0.25, big ? 1 : 0.8);
      for (let i = 0; i < (big ? 70 : 22); i++) {
        const a = Math.random() * Math.PI * 2, r = rand(60, big ? 320 : 180);
        tmpC.setRGB(1, rand(0.6, 0.85), rand(0.15, 0.35));
        this.glow.emit(pos.x + Math.cos(a) * 30, pos.y + 20, pos.z + Math.sin(a) * 30, Math.cos(a) * r, rand(300, big ? 950 : 600), Math.sin(a) * r,
          rand(0.35, 0.7), rand(10, big ? 22 : 16), tmpC, { drag: 1.6, gravity: -120 });
      }
    }

    // Demolition: fireball, flying sparks, a dark smoke plume and a ground shockwave
    demolition(pos) {
      this.burstFlash(pos, new THREE.Color(1, 0.8, 0.5), 1000, 0.3, 1);
      for (let i = 0; i < 170; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.4, 1), rand(-1, 1)).normalize().multiplyScalar(rand(200, 1300));
        const heat = Math.random();
        tmpC.setRGB(1, 0.3 + heat * 0.6, heat * 0.2);
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.4, 0.9), rand(40, 95), tmpC, { drag: 2.4, gravity: -80, grow: -0.3, opacity: 0.9 });
      }
      for (let i = 0; i < 90; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize().multiplyScalar(rand(600, 1900));
        tmpC.setRGB(1, rand(0.75, 0.95), rand(0.4, 0.6));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.6, 1.2), rand(12, 22), tmpC, { drag: 1.2, gravity: 1300 });
      }
      for (let i = 0; i < 60; i++) {
        tmpC.setRGB(0.1, 0.09, 0.09);
        this.smoke.emit(pos.x + rand(-60, 60), pos.y + rand(0, 60), pos.z + rand(-60, 60), rand(-160, 160), rand(120, 420), rand(-160, 160),
          rand(1.5, 2.6), rand(80, 160), tmpC, { grow: 2.5, drag: 1.4, gravity: -60, opacity: 0.6 });
      }
      this.shockRing(new THREE.Vector3(pos.x, 6, pos.z), UP, new THREE.Color(1, 0.55, 0.2), 760, 0.6, 0.1, 0.8);
      this.lightFlash(pos, new THREE.Color(1, 0.6, 0.3), 3.5);
      this.addShake(1.2);
    }

    flipReset(pos) {
      for (let i = 0; i < 70; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(250, 650));
        tmpC.setRGB(1, rand(0.3, 0.6), rand(0.85, 1));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.3, 0.6), rand(10, 20), tmpC, { drag: 3.5 });
      }
    }

    // Flip reset: a bright ring on the underside of the ball where the wheels touched it (normal = car up)
    flipResetRing(pos, normal) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff5fe0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 64), mat);
      ring.position.copy(pos);
      ring.lookAt(pos.clone().add(normal));
      this.scene.add(ring);
      this.rings.push({ mesh: ring, t: 0, dur: 0.75, min: 55, max: 150, fade: 1 });
    }

    // ---------------- goal explosions ----------------
    // pos: where the ball crossed the line; type: an EXPLOSIONS id
    // paintHex: a PAINTS colour, or null for the scorer's team colour
    goalExplosion(pos, teamHex, type, paintHex) {
      const painted = paintHex !== null && paintHex !== undefined;
      const team = new THREE.Color(painted ? paintHex : teamHex);
      const n = new THREE.Vector3(0, 0, pos.z > 0 ? -1 : 1); // out of the goal, toward the field
      const byType = {
        classic: this.goalClassic, partyTime: this.goalPartyTime, fireworks: this.goalFireworks,
        hellfire: this.goalHellfire, dragons: this.goalDragons, voxel: this.goalVoxel
      };
      (byType[type] || this.goalClassic).call(this, pos.clone(), team, n, painted);
    }

    goalClassic(pos, team, n) {
      const dark = isDark(team);
      const hot = dark ? team.clone().lerp(WHITE, 0.08) : team.clone().lerp(WHITE, 0.55);
      if (dark) this.burstFlash(pos, WHITE, 2600, 0.25, 0.5);
      this.burstFlash(pos, dark ? team : WHITE, 5200, 0.45, dark ? 0.85 : 1);
      this.burstFlash(pos, hot, 3400, 1.0, 0.9);
      this.shockRing(new THREE.Vector3(pos.x, 6, pos.z), UP, hot, 5200, 1.3, 0.06);
      this.shockRing(pos, n, team, 2800, 0.8, 0.08, 0.8);
      for (let i = 0; i < 900; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.15, 1), rand(-1, 1)).normalize();
        if (d.dot(n) < 0) d.addScaledVector(n, -1.6 * d.dot(n));
        d.normalize().multiplyScalar(rand(700, 3600));
        const white = Math.random() < 0.2;
        const c = white ? tmpC.copy(WHITE) : tmpC.copy(team).offsetHSL(rand(-0.03, 0.03), 0, dark ? rand(0, 0.06) : rand(-0.05, 0.2));
        this.paintEmit(dark && !white, pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.9, 2.3), rand(70, 200), c, { drag: 1.5, gravity: 850, grow: -0.5, opacity: 0.9 });
      }
      for (let i = 0; i < 160; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.1, 1), rand(-1, 1)).normalize().addScaledVector(n, 0.6).normalize().multiplyScalar(rand(2500, 5000));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.25, 0.5), rand(40, 70), WHITE, { drag: 3 });
      }
      for (let i = 0; i < 40; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(150, 900));
        tmpC.copy(team).lerp(new THREE.Color(0x101010), 0.75);
        this.smoke.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(1.4, 2.6), rand(250, 450), tmpC, { grow: 2, drag: 1.3, gravity: -60, opacity: 0.25 });
      }
      this.lightFlash(pos, dark ? WHITE : hot, dark ? 1.5 : 6);
      this.addShake(2.4);
    }

    // Party Time: poppers from both posts, a confetti burst, then balloons that rise to the roof and pop
    goalPartyTime(pos, team, n, painted) {
      const palette = painted ? paintPalette(team) : PARTY;
      this.burstFlash(pos, new THREE.Color(1, 0.95, 0.85), 1400, 0.3, 0.6);
      [-1, 1].forEach(s => {
        const origin = new THREE.Vector3(s * 760, 120, pos.z);
        for (let i = 0; i < 420; i++) {
          const dir = n.clone().multiplyScalar(rand(0.6, 1)).add(new THREE.Vector3(-s * rand(0.1, 0.6), rand(0.5, 1.4), 0)).normalize().multiplyScalar(rand(700, 2100));
          this.confetti.emit(origin, dir, palette[i % palette.length], rand(22, 36), rand(3, 5.5), { gravity: 260, drag: 1.4, spin: 9, flutter: 180 });
        }
        for (let i = 0; i < 26; i++) {
          const dir = n.clone().add(new THREE.Vector3(-s * rand(0.1, 0.5), rand(0.8, 1.5), 0)).normalize().multiplyScalar(rand(900, 1600));
          this.confetti.emit(origin, dir, palette[i % palette.length], rand(9, 12), rand(3.5, 5), { gravity: 200, drag: 1.6, spin: 4, flutter: 120, stretch: 7 });
        }
      });
      for (let i = 0; i < 360; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(0.1, 1), rand(-1, 1)).normalize().addScaledVector(n, 0.5).normalize().multiplyScalar(rand(400, 1500));
        this.confetti.emit(pos, d, palette[i % palette.length], rand(20, 32), rand(2.5, 4.5), { gravity: 260, drag: 1.5, spin: 10, flutter: 160 });
      }
      for (let i = 0; i < 16; i++) {
        const start = new THREE.Vector3(rand(-720, 720), rand(60, 320), pos.z + n.z * rand(60, 700));
        this.balloon(start, palette[i % Math.min(palette.length, 6)].clone(), rand(0, 0.9), palette);
      }
      this.addShake(0.8);
    }

    balloon(start, color, delay, palette) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 0.05, emissive: color, emissiveIntensity: 0.18 });
      const body = new THREE.Mesh(BALLOON_GEO, mat);
      body.scale.set(1, 1.22, 1);
      g.add(body);
      const knot = new THREE.Mesh(KNOT_GEO, mat);
      knot.position.y = -86;
      g.add(knot);
      const string = new THREE.Line(STRING_GEO, STRING_MAT);
      string.position.y = -95;
      g.add(string);
      g.position.copy(start);
      g.visible = false;
      this.scene.add(g);
      const speed = rand(260, 420), phase = rand(0, 6.28), life = rand(4.5, 7.5);
      this.addActor((a, dt) => {
        if (a.t < delay) return true;
        const t = a.t - delay;
        g.visible = true;
        g.position.y += speed * dt;
        g.position.x += Math.sin(t * 1.7 + phase) * 45 * dt;
        g.rotation.z = Math.sin(t * 1.3 + phase) * 0.2;
        g.scale.setScalar(Math.min(1, t / 0.35));
        if (g.position.y > 1880 || t > life) {
          this.scene.remove(g);
          mat.dispose();
          for (let i = 0; i < 40; i++) {
            const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(150, 600));
            this.confetti.emit(g.position, d, i % 2 ? color : palette[i % palette.length], rand(10, 16), rand(2, 3.5), { gravity: 220, drag: 1.8, spin: 10, flutter: 120 });
          }
          this.burstFlash(g.position, color, 260, 0.15, 0.7);
          if (this.onPop) this.onPop(g.position.clone());
          return false;
        }
        return true;
      });
    }

    // Fireworks: rockets launch from the goal and burst, each burst setting off smaller ones
    goalFireworks(pos, team, n, painted) {
      const palette = painted ? [team, team.clone().offsetHSL(0, 0, 0.1), team] : [team, WHITE, new THREE.Color(1, 0.8, 0.3), team.clone().offsetHSL(0.5, 0, 0), new THREE.Color().setHSL(Math.random(), 1, 0.6)];
      this.burstFlash(pos, team.clone().lerp(WHITE, 0.5), 1600, 0.35, 0.8);
      for (let r = 0; r < 8; r++) {
        const delay = r * 0.16 + rand(0, 0.08);
        const p = new THREE.Vector3(rand(-650, 650), 60, pos.z + n.z * rand(0, 250));
        const vel = new THREE.Vector3(rand(-260, 260), rand(1500, 2100), 0).addScaledVector(n, rand(250, 700));
        const fuse = rand(0.55, 0.85), color = palette[r % palette.length].clone();
        let carry = 0;
        this.addActor((a, dt) => {
          if (a.t < delay) return true;
          vel.y -= 700 * dt;
          p.addScaledVector(vel, dt);
          carry += dt * 90;
          for (; carry >= 1; carry--) {
            tmpC.setRGB(1, 0.8, 0.45);
            this.glow.emit(p.x, p.y, p.z, rand(-40, 40), rand(-80, 20), rand(-40, 40), rand(0.25, 0.5), rand(35, 55), tmpC, { drag: 2, twinkle: 1 });
          }
          if (a.t - delay >= fuse) { this.fireworkBurst(p.clone(), color, 1, painted); return false; }
          return true;
        });
      }
      this.addShake(1.2);
    }

    fireworkBurst(p, color, generation, painted) {
      const first = generation === 1, dark = isDark(color);
      for (let i = 0; i < (first ? 220 : 60); i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(first ? rand(550, 950) : rand(250, 450));
        const c = Math.random() < 0.15 ? WHITE : color;
        this.paintEmit(dark && c !== WHITE, p.x, p.y, p.z, d.x, d.y, d.z, rand(1.1, 1.9), first ? rand(60, 100) : rand(30, 50), c, { drag: 1.5, gravity: 260, twinkle: first ? 0 : 1 });
      }
      this.burstFlash(p, color, first ? 1700 : 650, 0.35, 0.9);
      if (this.onFirework) this.onFirework(p.clone(), generation);
      if (!first) return;
      for (let k = 0; k < 4; k++) {
        const child = p.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(250, 520)));
        const wait = rand(0.3, 0.6), childColor = painted ? color : Math.random() < 0.5 ? WHITE : new THREE.Color(1, 0.8, 0.3);
        this.addActor(a => {
          if (a.t < wait) return true;
          this.fireworkBurst(child, childColor, 2, painted);
          return false;
        });
      }
    }

    // Hellfire: a roaring column of flame, embers raining up, dark smoke and a glowing scorch ring
    goalHellfire(pos, team, n, painted) {
      const dark = painted && isDark(team);
      const floor = new THREE.Vector3(pos.x * 0.5, 20, pos.z);
      this.burstFlash(pos, painted ? team.clone().lerp(WHITE, dark ? 0 : 0.3) : new THREE.Color(1, 0.55, 0.15), 2600, 0.5, 1);
      this.shockRing(new THREE.Vector3(floor.x, 6, floor.z), UP, painted ? team : new THREE.Color(1, 0.25, 0.05), 1800, 1.8, 0.35, 0.9);
      let carry = 0;
      this.addActor((a, dt) => {
        const k = a.t / 1.8;
        if (k >= 1) return false;
        carry += dt * 900 * (1 - k * 0.7);
        for (; carry >= 1; carry--) {
          const ang = rand(0, 6.28), r = rand(0, 380), heat = Math.random();
          if (painted) tmpC.copy(team).lerp(WHITE, dark ? heat * 0.1 : heat * 0.45);
          else tmpC.setRGB(1, 0.25 + heat * 0.6, heat * 0.25);
          this.paintEmit(dark, floor.x + Math.cos(ang) * r, floor.y, floor.z + Math.sin(ang) * r * 0.6,
            rand(-120, 120), rand(900, 2000) * (1 - k * 0.5), rand(-120, 120) + n.z * rand(150, 450),
            rand(0.45, 1.0), rand(150, 320), tmpC, { drag: 1.3, gravity: -150, grow: -0.35, opacity: 0.9 });
        }
        return true;
      });
      for (let i = 0; i < 300; i++) {
        if (painted && !dark) tmpC.copy(team).lerp(WHITE, rand(0.3, 0.6));
        else tmpC.setRGB(1, rand(0.4, 0.7), rand(0.05, 0.2));
        this.glow.emit(floor.x + rand(-400, 400), floor.y + rand(0, 200), floor.z + rand(-250, 250), rand(-200, 200), rand(300, 1200), rand(-200, 200) + n.z * 200,
          rand(1.6, 3.2), rand(25, 45), tmpC, { drag: 0.8, gravity: -60, twinkle: 1 });
      }
      for (let i = 0; i < 45; i++) {
        tmpC.setRGB(0.12, 0.08, 0.07);
        this.smoke.emit(floor.x + rand(-300, 300), floor.y + rand(300, 700), floor.z + rand(-200, 200), rand(-120, 120), rand(200, 600), rand(-120, 120),
          rand(2, 3.2), rand(220, 400), tmpC, { grow: 2.4, drag: 1, gravity: -120, opacity: 0.38 });
      }
      this.lightFlash(pos, painted ? (dark ? WHITE : team) : new THREE.Color(1, 0.45, 0.1), dark ? 1.5 : 6);
      this.addShake(2.6);
    }

    // Dueling Dragons: two dragons of fire spiral out of the goal around each other
    goalDragons(pos, team, n, painted) {
      const colors = painted ? [team.clone(), team.clone().offsetHSL(0, 0, isDark(team) ? 0.1 : 0.18)]
        : [team.clone().lerp(WHITE, 0.15), new THREE.Color(1, 0.62, 0.12)];
      const base = new THREE.Vector3(0, 80, pos.z);
      this.burstFlash(pos, colors[1], 1800, 0.4, 0.8);
      colors.forEach((color, d) => {
        const phase = d * Math.PI, dark = isDark(color);
        const headMat = new THREE.SpriteMaterial({ map: GLOW_TEX, color, transparent: true, opacity: 0, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        const head = new THREE.Sprite(headMat);
        head.scale.set(560, 560, 1);
        this.scene.add(head);
        let carry = 0, prev = null;
        this.addActor((a, dt) => {
          const T = 2.8, k = a.t / T;
          if (k >= 1) {
            this.scene.remove(head);
            headMat.dispose();
            for (let i = 0; i < 120; i++) {
              const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(300, 900));
              this.paintEmit(dark, head.position.x, head.position.y, head.position.z, v.x, v.y, v.z, rand(0.6, 1.2), rand(60, 110), color, { drag: 1.8, gravity: 300 });
            }
            return false;
          }
          const ang = phase + a.t * 4.6, radius = 320 + 160 * Math.sin(a.t * 2.2);
          const p = base.clone().addScaledVector(n, 350 + a.t * 520);
          p.x += Math.cos(ang) * radius;
          p.y = 120 + a.t * 620 + Math.sin(ang) * radius * 0.6;
          head.position.copy(p);
          headMat.opacity = Math.min(1, a.t * 4) * (1 - k * k);
          carry += dt * 170;
          if (prev) {
            for (; carry >= 1; carry--) {
              const q = prev.clone().lerp(p, Math.random());
              tmpC.copy(color).multiplyScalar(rand(0.8, 1.3));
              this.paintEmit(dark, q.x, q.y, q.z, rand(-60, 60), rand(-40, 80), rand(-60, 60), rand(0.35, 0.6), rand(150, 250), tmpC, { drag: 2.5, grow: -0.6, opacity: 0.85 });
              if (Math.random() < 0.25) this.paintEmit(dark, q.x, q.y, q.z, rand(-200, 200), rand(-100, 200), rand(-200, 200), rand(0.8, 1.4), rand(25, 40), color, { drag: 1.5, gravity: 150, twinkle: 1 });
            }
          } else carry = 0;
          prev = p;
          return true;
        });
      });
      this.addShake(1.4);
    }

    // Voxel: pixel fire made of blocks, half fire colours and half team colour
    goalVoxel(pos, team, n) {
      const fire = [new THREE.Color(2.2, 1.9, 0.6), new THREE.Color(2.2, 1.1, 0.2), new THREE.Color(1.8, 0.35, 0.08)];
      const teamGlow = isDark(team) ? team.clone() : team.clone().multiplyScalar(1.8);
      this.burstFlash(pos, new THREE.Color(1, 0.8, 0.4), 1600, 0.3, 0.8);
      let carry = 0;
      this.addActor((a, dt) => {
        const k = a.t / 1.4;
        if (k >= 1) return false;
        carry += dt * 520 * (1 - k * 0.6);
        for (; carry >= 1; carry--) {
          const start = new THREE.Vector3(rand(-620, 620), rand(10, 90), pos.z + n.z * rand(0, 200));
          const v = new THREE.Vector3(rand(-260, 260), rand(700, 2100), 0).addScaledVector(n, rand(100, 600));
          const c = Math.random() < 0.5 ? teamGlow : fire[Math.floor(Math.random() * 3)];
          this.voxels.emit(start, v, c, Math.round(rand(2, 5)) * 18, rand(0.8, 1.6), { gravity: 520, drag: 0.9, shrink: true });
        }
        return true;
      });
      this.addShake(1.6);
    }

    addShake(amount) { this.shake = Math.min(this.shake + amount, 3); }

    shakeOffset(dt, enabled) {
      this.shake *= Math.exp(-5 * dt);
      if (!enabled || this.shake < 0.01) return null;
      const a = this.shake * 9;
      return new THREE.Vector3(rand(-a, a), rand(-a, a), rand(-a, a));
    }

    update(dt) {
      this.glow.update(dt);
      this.smoke.update(dt);
      this.ink.update(dt);
      this.confetti.update(dt);
      this.voxels.update(dt);
      this.updateTrails(dt);
      this.light.intensity *= Math.exp(-4 * dt);
      if (dt > 0) {
        // Actors may start new actors while they run; those land in the fresh list and are kept
        const running = this.actors;
        this.actors = [];
        const kept = running.filter(a => { a.t += dt; return a.update(a, dt) !== false; });
        this.actors = kept.concat(this.actors);
      }
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.t += dt;
        const k = Math.min(r.t / r.dur, 1);
        const s = (r.min || 0) + (r.max - (r.min || 0)) * (1 - Math.pow(1 - k, 3));
        r.mesh.scale.set(s, s, s);
        r.mesh.material.opacity = (1 - k) * r.fade;
        if (k >= 1) {
          this.scene.remove(r.mesh);
          r.mesh.geometry.dispose();
          r.mesh.material.dispose();
          this.rings.splice(i, 1);
        }
      }
    }
  }

  // Full-screen supersonic effect: radial blur toward the edges, chromatic fringing, flickering
  // speed streaks and a cool vignette. `amount` eases 0..1.
  const SpeedShader = {
    uniforms: { tDiffuse: { value: null }, amount: { value: 0 }, time: { value: 0 }, aspect: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float amount; uniform float time; uniform float aspect;
      varying vec2 vUv;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c * vec2(aspect, 1.0));
        float blur = amount * 0.06 * smoothstep(0.12, 0.85, r);
        vec4 col = vec4(0.0);
        for (int i = 0; i < 10; i++) { col += texture2D(tDiffuse, vUv - c * blur * (float(i) / 9.0)); }
        col /= 10.0;
        float ca = amount * 0.006 * r;
        col.r = mix(col.r, texture2D(tDiffuse, vUv - c * (blur * 0.5 + ca)).r, 0.7);
        col.b = mix(col.b, texture2D(tDiffuse, vUv + c * ca).b, 0.7);
        float ang = atan(c.y, c.x);
        float seg = floor(ang * 45.0);
        float streak = step(0.9, h1(seg * 1.7 + floor(time * 18.0))) * smoothstep(0.32, 0.8, r) * amount;
        streak *= smoothstep(0.0, 0.2, fract(ang * 45.0)) * (1.0 - smoothstep(0.35, 0.6, fract(ang * 45.0)));
        col.rgb += vec3(0.75, 0.88, 1.0) * streak * 0.35;
        float v = smoothstep(0.4, 1.0, r);
        col.rgb = mix(col.rgb, col.rgb * vec3(0.78, 0.88, 1.12), v * amount);
        col.rgb *= 1.0 - v * amount * 0.35;
        gl_FragColor = col;
      }`
  };

  return { Effects, SpeedShader, EXPLOSIONS, PAINTS };
})();
