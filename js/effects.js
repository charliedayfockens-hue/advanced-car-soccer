// Particle effects (boost exhaust, hit sparks, dust, goal explosion) and camera shake.
// Everything is in three.js world space (uu).
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

  class Effects {
    constructor(scene) {
      this.scene = scene;
      this.glow = new Particles(scene, 4000, true);
      this.smoke = new Particles(scene, 900, false);
      this.rings = [];
      this.shake = 0;
      this.flash = new THREE.PointLight(0xffffff, 0, 5000, 2);
      scene.add(this.flash);
      this.boostCarry = 0;
      this.carries = new Map();
      this.trails = new Map();
    }

    setViewportHeight(h, fov) {
      const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
      this.glow.material.uniforms.scale.value = scale;
      this.smoke.material.uniforms.scale.value = scale;
    }

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
        if (supersonic && Math.random() < 0.6) {
          const p = new THREE.Vector3(rand(-60, 40), rand(5, 40), rand(-44, 44)).applyQuaternion(carQuat).add(carPos);
          tmpC.setRGB(0.75, 0.9, 1);
          this.glow.emit(p.x, p.y, p.z, carVel.x * 0.1, carVel.y * 0.1, carVel.z * 0.1, rand(0.25, 0.45), rand(6, 10), tmpC);
        }
      }
      this.carries.set(key, carry);
    }

    // Gold "Alpha" style boost: white-hot core, gold flame streaks, a glowing gold ribbon trail and
    // twinkling gold glitter that hangs in the air behind the car.
    boostAlpha(key, carPos, carQuat, carVel, supersonic, dt) {
      const st = this.trailState(key);
      st.carry += dt * (supersonic ? 190 : 150);
      const back = new THREE.Vector3(-1, 0, 0).applyQuaternion(carQuat);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(carQuat);
      const right = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
      while (st.carry >= 1) {
        st.carry -= 1;
        [-15, 15].forEach(side => {
          const p = new THREE.Vector3(-60, 1, side).applyQuaternion(carQuat).add(carPos);
          const sp = rand(420, 780);
          // core
          tmpC.setRGB(1, 0.95, 0.75);
          this.glow.emit(p.x, p.y, p.z, carVel.x * 0.5 + back.x * sp, carVel.y * 0.5 + back.y * sp, carVel.z * 0.5 + back.z * sp,
            rand(0.07, 0.12), rand(14, 20), tmpC, { grow: -0.7, drag: 3 });
          // gold flame
          tmpC.setRGB(1, rand(0.55, 0.75), rand(0.08, 0.2));
          this.glow.emit(p.x, p.y, p.z, carVel.x * 0.35 + back.x * sp * 0.8 + rand(-40, 40), carVel.y * 0.35 + back.y * sp * 0.8 + rand(-40, 40), carVel.z * 0.35 + back.z * sp * 0.8 + rand(-40, 40),
            rand(0.18, 0.3), rand(18, 28), tmpC, { grow: -0.5, drag: 2.2 });
          // glitter that lingers and twinkles
          if (Math.random() < 0.55) {
            const a = Math.random() * Math.PI * 2, r = rand(40, 160);
            const v = right.clone().multiplyScalar(Math.cos(a) * r).add(up.clone().multiplyScalar(Math.sin(a) * r)).addScaledVector(back, rand(80, 260));
            tmpC.setRGB(1, rand(0.78, 0.92), rand(0.35, 0.55));
            this.glow.emit(p.x, p.y, p.z, carVel.x * 0.15 + v.x, carVel.y * 0.15 + v.y, carVel.z * 0.15 + v.z,
              rand(0.6, 1.1), rand(5, 9), tmpC, { drag: 2.5, gravity: 60, twinkle: 1 });
          }
        });
      }
      // ribbon trail points (sampled from the exhaust centre)
      const exhaust = new THREE.Vector3(-58, 2, 0).applyQuaternion(carQuat).add(carPos);
      st.points.unshift({ p: exhaust, up: up.clone(), age: 0 });
      st.active = true;
    }

    trailState(key) {
      let st = this.trails.get(key);
      if (!st) {
        const geo = new THREE.BufferGeometry();
        const max = 48;
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(max * 2), 1).setUsage(THREE.DynamicDrawUsage));
        const idx = [];
        for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        geo.setIndex(idx);
        const mat = new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          uniforms: { time: { value: 0 } },
          vertexShader: 'attribute float alpha; varying float vA; varying vec2 vUvS; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'varying float vA; void main(){ vec3 gold = mix(vec3(1.0,0.55,0.08), vec3(1.0,0.95,0.7), vA); gl_FragColor = vec4(gold * (0.6 + 0.8 * vA), vA * vA * 0.85); }'
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 6;
        this.scene.add(mesh);
        st = { carry: 0, points: [], mesh, max, active: false };
        this.trails.set(key, st);
      }
      return st;
    }

    updateTrails(dt) {
      this.trails.forEach(st => {
        st.points.forEach(pt => { pt.age += dt; });
        while (st.points.length && (st.points.length > st.max || st.points[st.points.length - 1].age > 0.35)) st.points.pop();
        if (!st.active && st.points.length) st.points.forEach(pt => { pt.age += dt * 2; });
        st.active = false;
        const pos = st.mesh.geometry.attributes.position, al = st.mesh.geometry.attributes.alpha;
        for (let i = 0; i < st.max; i++) {
          const pt = st.points[Math.min(i, st.points.length - 1)];
          if (!pt) { al.setX(i * 2, 0); al.setX(i * 2 + 1, 0); continue; }
          const life = 1 - Math.min(pt.age / 0.35, 1);
          const w = 9 * life + 2;
          pos.setXYZ(i * 2, pt.p.x + pt.up.x * w, pt.p.y + pt.up.y * w, pt.p.z + pt.up.z * w);
          pos.setXYZ(i * 2 + 1, pt.p.x - pt.up.x * w, pt.p.y - pt.up.y * w, pt.p.z - pt.up.z * w);
          const a = i < st.points.length ? life : 0;
          al.setX(i * 2, a); al.setX(i * 2 + 1, a);
        }
        pos.needsUpdate = al.needsUpdate = true;
      });
    }

    ballHit(pos, strength) {
      const k = Math.min(strength / 3000, 1);
      const n = Math.round(8 + k * 40);
      for (let i = 0; i < n; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(200, 700 + 900 * k));
        tmpC.setRGB(1, rand(0.8, 1), rand(0.5, 0.9));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.15, 0.4), rand(8, 18), tmpC, { drag: 3, gravity: 400 });
      }
      this.addShake(0.15 + k * 0.6);
    }

    dust(pos, strength) {
      const k = Math.min(strength / 1500, 1);
      for (let i = 0; i < 6 + k * 12; i++) {
        tmpC.setRGB(0.62, 0.66, 0.6);
        this.smoke.emit(pos.x + rand(-40, 40), pos.y + 5, pos.z + rand(-40, 40), rand(-150, 150), rand(20, 90), rand(-150, 150),
          rand(0.4, 0.8), rand(18, 34), tmpC, { grow: 2, drag: 2.5, opacity: 0.35 });
      }
      this.addShake(k * 0.35);
    }

    boostPickup(pos, big) {
      for (let i = 0; i < (big ? 50 : 18); i++) {
        const a = Math.random() * Math.PI * 2, s = rand(150, big ? 600 : 350);
        tmpC.setRGB(1, 0.75, 0.25);
        this.glow.emit(pos.x, pos.y + 20, pos.z, Math.cos(a) * s, rand(100, 400), Math.sin(a) * s, rand(0.3, 0.6), rand(10, 20), tmpC, { drag: 2.5, gravity: 300 });
      }
    }

    goalExplosion(pos, teamHex) {
      const team = new THREE.Color(teamHex);
      for (let i = 0; i < 700; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize().multiplyScalar(rand(400, 3200));
        const c = Math.random() < 0.15 ? tmpC.setRGB(1, 0.95, 0.85) : tmpC.copy(team).offsetHSL(rand(-0.04, 0.04), 0, rand(-0.1, 0.1));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.8, 2.0), rand(25, 80), c, { drag: 1.6, gravity: 350, grow: -0.4, opacity: 0.8 });
      }
      for (let i = 0; i < 120; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(150, 900));
        tmpC.copy(team).lerp(new THREE.Color(0x222222), 0.55);
        this.smoke.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(1.6, 3.2), rand(160, 320), tmpC, { grow: 2.2, drag: 1.2, opacity: 0.55 });
      }

      const ringMat = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 64), ringMat);
      ring.position.copy(pos);
      ring.rotation.x = Math.PI / 2;
      this.scene.add(ring);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
      ball.position.copy(pos);
      this.scene.add(ball);
      ball.material.color.copy(team).lerp(new THREE.Color(0xffffff), 0.5);
      this.rings.push({ mesh: ring, t: 0, dur: 1.1, max: 4200, fade: 1 }, { mesh: ball, t: 0, dur: 0.35, max: 650, fade: 0.5 });

      this.flash.color.copy(team).lerp(new THREE.Color(0xffffff), 0.3);
      this.flash.position.copy(pos);
      this.flash.intensity = 4;
      this.addShake(2.2);
    }

    // Shock ring and a burst of streaks when the car breaks the supersonic barrier
    sonicBoom(pos, quat) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 48), mat);
      ring.position.copy(pos);
      ring.quaternion.copy(quat);
      ring.rotateY(Math.PI / 2);
      this.scene.add(ring);
      this.rings.push({ mesh: ring, t: 0, dur: 0.55, max: 240, fade: 0.9 });
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
      const right = new THREE.Vector3(0, 0, 1).applyQuaternion(quat), up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = right.clone().multiplyScalar(Math.cos(a)).add(up.clone().multiplyScalar(Math.sin(a))).multiplyScalar(rand(500, 900)).addScaledVector(fwd, -rand(100, 400));
        tmpC.setRGB(0.75, 0.9, 1);
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.2, 0.4), rand(10, 18), tmpC, { drag: 4 });
      }
      this.addShake(0.4);
    }

    flipReset(pos) {
      for (let i = 0; i < 70; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(250, 650));
        tmpC.setRGB(1, rand(0.3, 0.6), rand(0.85, 1));
        this.glow.emit(pos.x, pos.y, pos.z, d.x, d.y, d.z, rand(0.3, 0.6), rand(10, 20), tmpC, { drag: 3.5 });
      }
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
      this.updateTrails(dt);
      this.flash.intensity *= Math.exp(-4 * dt);
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.t += dt;
        const k = Math.min(r.t / r.dur, 1);
        const s = r.max * (1 - Math.pow(1 - k, 3));
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

  return { Effects, SpeedShader };
})();
