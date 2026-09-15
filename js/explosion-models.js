// 3D models for two goal explosions, built from geometry at runtime (no downloaded assets):
//  - Hellfire: a horned demon skull of cooling lava rises out of a cracked crater, its eyes ignite, it roars a
//    torrent of fire across the pitch while flaming meteors fall from its horns, then crumbles into embers
//  - Dueling Dragons: two scaled dragons (serpent bodies, horned heads with opening jaws, membrane wings and back
//    spines) burst from a swirling portal, spiral up around each other breathing fire and clash at the top
// Replaces goalHellfire and goalDragons from effects.js / explosions.js; uses the helpers from explosions.js.
window.Game = window.Game || {};

Game.ExplosionModels = (function () {
  const P = Game.Effects.Effects.prototype;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const WHITE = new THREE.Color(1, 1, 1);
  const WORLD_UP = V(0, 1, 0);
  const isDark = c => Math.max(c.r, c.g, c.b) < 0.5;
  const glowOf = c => (isDark(c) ? c.clone().lerp(WHITE, 0.4) : c.clone());
  const randVec = s => V(rand(-s, s), rand(-s, s), rand(-s, s));

  // ---------------- shaders ----------------
  const NOISE = `
    float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise3(vec3 x) {
      vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                 mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise3(p); p *= 2.03; a *= 0.5; } return v; }`;

  const LIT_VERT = `
    varying vec3 vPos; varying vec2 vUv; varying vec3 vN; varying vec3 vWN; varying vec3 vView;
    void main() {
      vPos = position; vUv = uv;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vView = -mv.xyz;
      vN = normalize(normalMatrix * normal);
      vWN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * mv;
    }`;

  // Lit volcanic rock with thin glowing lava cracks, dark eye sockets that glow from inside (the `ao` attribute
  // marks carved-in areas), a fresnel rim, and a noise dissolve with burning edges
  function moltenMaterial(vein) {
    return new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, vein: { value: vein }, glow: { value: 0.2 }, dissolve: { value: 0 } },
      vertexShader: `
        attribute float ao;
        varying vec3 vPos; varying vec3 vN; varying vec3 vWN; varying vec3 vView; varying float vAo;
        void main() {
          vPos = position; vAo = ao;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = -mv.xyz;
          vN = normalize(normalMatrix * normal);
          vWN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: NOISE + `
        uniform float time; uniform vec3 vein; uniform float glow; uniform float dissolve;
        varying vec3 vPos; varying vec3 vN; varying vec3 vWN; varying vec3 vView; varying float vAo;
        void main() {
          float d = fbm(vPos * 3.5 + 11.0);
          if (d < dissolve) discard;
          float edge = 1.0 - smoothstep(0.0, 0.08, d - dissolve);
          float ridge = 1.0 - abs(fbm(vPos * 1.6 + vec3(0.0, time * 0.1, 0.0)) * 2.0 - 1.0);
          float crack = smoothstep(0.9, 0.985, ridge);
          float grain = fbm(vPos * 9.0);
          vec3 wn = normalize(vWN);
          float diff = max(dot(wn, normalize(vec3(0.3, 1.0, 0.6))), 0.0);
          float hemi = 0.5 + 0.5 * wn.y;
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 3.0);
          float pulse = 0.75 + 0.25 * sin(time * 7.0 + vPos.y * 4.0);
          vec3 rock = mix(vec3(0.05, 0.045, 0.05), vec3(0.24, 0.2, 0.18), grain) * (0.22 + 0.58 * diff + 0.2 * hemi) * (1.0 - 0.9 * vAo);
          vec3 col = rock + vein * crack * (0.3 + 1.4 * glow * pulse) + vein * fres * (0.08 + 0.4 * glow)
            + vein * vAo * vAo * glow * 0.8 + vein * edge * 3.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide
    });
  }

  // Scales along uv (u head -> tail, v around with 0 on the back), lighter belly, glowing rim and a pulse
  // travelling down the body; dissolves the same way as the skull
  function scaleMaterial(color, belly, glow) {
    return new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: color }, belly: { value: belly }, glowColor: { value: glow }, glow: { value: 1 }, dissolve: { value: 0 } },
      vertexShader: LIT_VERT,
      fragmentShader: NOISE + `
        uniform float time; uniform vec3 color; uniform vec3 belly; uniform vec3 glowColor; uniform float glow; uniform float dissolve;
        varying vec3 vPos; varying vec2 vUv; varying vec3 vN; varying vec3 vWN; varying vec3 vView;
        void main() {
          float d = fbm(vec3(vUv.x * 24.0, vUv.y * 6.0, 3.0) + vPos * 0.004);
          if (d < dissolve) discard;
          float edge = 1.0 - smoothstep(0.0, 0.08, d - dissolve);
          vec2 g = vec2(vUv.x * 90.0, vUv.y * 14.0);
          vec2 cell = fract(vec2(g.x + mod(floor(g.y), 2.0) * 0.5, g.y)) - vec2(0.5, 0.2);
          float sc = smoothstep(0.32, 0.5, length(cell * vec2(1.0, 1.3)));
          float back = 0.5 + 0.5 * cos(vUv.y * 6.2831853);
          vec3 base = mix(belly, color, smoothstep(0.15, 0.55, back));
          float light = 0.35 + 0.65 * max(dot(normalize(vWN), normalize(vec3(0.3, 1.0, 0.4))), 0.0);
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.5);
          float wave = pow(0.5 + 0.5 * sin(vUv.x * 30.0 - time * 12.0), 8.0);
          vec3 col = base * light * (1.0 - sc * 0.55) + glowColor * glow * (fres * 1.4 + sc * 0.25 * back + wave * 0.6) + glowColor * edge * 4.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide
    });
  }

  function membraneMaterial(glow) {
    return new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: glow }, opacity: { value: 0 }, time: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 glowColor; uniform float opacity; uniform float time; varying vec2 vUv;
        void main() {
          float veins = pow(abs(sin(atan(vUv.y - 0.4, vUv.x + 0.1) * 9.0)), 24.0);
          float shimmer = 0.5 + 0.5 * sin(vUv.x * 12.0 + time * 6.0);
          vec3 col = glowColor * (0.35 + 0.5 * vUv.y + veins * 1.2 + shimmer * 0.2);
          gl_FragColor = vec4(col, opacity * (0.45 + 0.35 * vUv.x + veins * 0.2));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    });
  }

  // Flat effect discs (crater, portal): additive shader on a plane
  function fxDisc(frag, color, radius) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: color }, fade: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: NOISE + frag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
    mesh.renderOrder = 4;
    return mesh;
  }
  const CRATER_FRAG = `
    uniform float time; uniform vec3 color; uniform float fade; varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
      float a = atan(p.y, p.x);
      float cracks = 1.0 - abs(fbm(vec3(cos(a) * 2.5, sin(a) * 2.5, r * 5.0 - time * 0.6)) * 2.0 - 1.0);
      cracks = smoothstep(0.84, 0.98, cracks) * smoothstep(1.0, 0.5, r);
      float pool = smoothstep(0.42, 0.0, r) * (0.55 + 0.45 * fbm(vec3(p * 5.0, time * 1.5)));
      float rim = smoothstep(0.06, 0.0, abs(r - 0.42)) * 0.8;
      float v = (cracks * 1.6 + pool * 1.3 + rim) * fade;
      gl_FragColor = vec4(color * v * 1.5, v);
    }`;
  const PORTAL_FRAG = `
    uniform float time; uniform vec3 color; uniform float fade; varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
      float a = atan(p.y, p.x);
      float swirl = 0.5 + 0.5 * sin(a * 5.0 + r * 9.0 - time * 8.0);
      float n = fbm(vec3(p * 3.0, time * 0.8));
      float ring = smoothstep(0.1, 0.0, abs(r - 0.9)) * 1.5;
      float core = smoothstep(0.9, 0.0, r);
      float v = (swirl * core * (0.6 + 0.8 * n) + ring + core * 0.3) * fade;
      gl_FragColor = vec4(mix(color, vec3(1.0), core * core * 0.5) * v * 1.4, v);
    }`;

  const GLOW_TEX = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.75)'); r.addColorStop(0.6, 'rgba(255,255,255,0.15)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const glowSprite = color => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    s.renderOrder = 7;
    return s;
  };

  // ---------------- geometry helpers ----------------
  // Concatenates geometries into one non-indexed geometry (position, normal, uv, ao)
  function mergeGeometries(list) {
    const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
    const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2), ao = new Float32Array(count);
    let o = 0;
    parts.forEach(g => {
      pos.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      if (g.attributes.ao) ao.set(g.attributes.ao.array, o);
      o += g.attributes.position.count;
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
    return out;
  }

  // Tube along a smooth curve whose radius goes from r0 to r1 (horns, spikes, wing bones)
  function taperedTube(points, r0, r1, tubular = 24, radial = 8) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => (p.isVector3 ? p : V(p[0], p[1], p[2]))));
    const g = new THREE.TubeGeometry(curve, tubular, 1, radial, false), pos = g.attributes.position, v = V(0, 0, 0);
    for (let i = 0; i <= tubular; i++) {
      const u = i / tubular, c = curve.getPointAt(u), r = r0 + (r1 - r0) * Math.pow(u, 0.9);
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
        pos.setXYZ(k, v.x, v.y, v.z);
      }
    }
    g.computeVertexNormals();
    return g;
  }
  const mirrored = (pts, s) => pts.map(p => V(p[0] * s, p[1], p[2]));
  const mirroredZ = (pts, s) => pts.map(p => V(p[0], p[1], p[2] * s));

  // ---------------- skull model (units: cranium radius 1, face toward +Z) ----------------
  let skullCache = null;
  function skullModel() {
    if (skullCache) return skullCache;
    const cran = new THREE.SphereGeometry(1, 72, 54);
    const p = cran.attributes.position, o = V(0, 0, 0), v = V(0, 0, 0), aoArr = new Float32Array(p.count);
    const dent = (c, rx, ry, rz, depth) => {
      const dx = (o.x - c[0]) / rx, dy = (o.y - c[1]) / ry, dz = (o.z - c[2]) / rz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return d < 1 ? depth * (1 - d) * (1 - d) : 0;
    };
    for (let i = 0; i < p.count; i++) {
      o.fromBufferAttribute(p, i);
      v.copy(o);
      const push = dent([0.36, 0.02, 0.92], 0.3, 0.26, 0.45, 0.45) + dent([-0.36, 0.02, 0.92], 0.3, 0.26, 0.45, 0.45) +   // eye sockets
        dent([0, -0.3, 0.98], 0.11, 0.17, 0.3, 0.3) +                                                                      // nose
        dent([0.92, 0.05, 0.1], 0.25, 0.3, 0.35, 0.14) + dent([-0.92, 0.05, 0.1], 0.25, 0.3, 0.35, 0.14);                  // temples
      v.addScaledVector(o, -push);
      aoArr[i] = clamp01(push / 0.16);
      if (o.z > 0.2) v.y += 0.11 * Math.exp(-Math.pow((o.y - 0.3) / 0.1, 2)) * smooth(0.2, 0.8, o.z) * (1 - Math.abs(o.x) * 0.5); // brow ridge
      v.x *= 0.88; v.z *= 1.08;
      if (o.y < 0) { const k = -o.y; v.x *= 1 - 0.3 * k; v.z *= 1 - 0.05 * k; }
      if (v.y < -0.58) v.y = -0.58 + (v.y + 0.58) * 0.25; // flat upper jaw line
      p.setXYZ(i, v.x, v.y, v.z);
    }
    cran.computeVertexNormals();
    cran.setAttribute('ao', new THREE.BufferAttribute(aoArr, 1));

    const parts = [cran];
    [1, -1].forEach(s => {
      parts.push(taperedTube(mirrored([[0.6, 0.45, 0.0], [1.0, 0.72, -0.1], [1.38, 1.2, 0.05], [1.4, 1.8, 0.45], [1.12, 2.2, 0.95]], s), 0.22, 0.0, 36, 12)); // demon horns
      parts.push(taperedTube(mirrored([[0.3, 0.82, -0.3], [0.45, 1.18, -0.7], [0.4, 1.4, -1.1]], s), 0.1, 0, 14, 7));                                    // crown spikes
      parts.push(taperedTube(mirrored([[0.78, -0.1, 0.35], [1.1, -0.2, 0.2], [1.35, -0.1, -0.2]], s), 0.09, 0, 12, 6));                                    // cheek spurs
    });
    for (let i = 0; i < 12; i++) {
      const a = (i / 11 - 0.5) * 2.0, fang = i === 2 || i === 9, len = fang ? 0.42 : 0.16;
      const c = new THREE.ConeGeometry(fang ? 0.07 : 0.05, len, 6);
      c.rotateX(Math.PI);
      c.translate(Math.sin(a) * 0.5, -0.6 - len / 2, 0.3 + Math.cos(a) * 0.55);
      parts.push(c);
    }
    const jaw = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5);
    jaw.scale(0.6, 0.42, 0.72);
    jaw.translate(0, -0.58, 0.22);
    const jawParts = [jaw];
    for (let i = 0; i < 10; i++) {
      const a = (i / 9 - 0.5) * 1.8, fang = i === 1 || i === 8, len = fang ? 0.34 : 0.14;
      const c = new THREE.ConeGeometry(fang ? 0.06 : 0.045, len, 6);
      c.translate(Math.sin(a) * 0.46, -0.62 + len / 2, 0.25 + Math.cos(a) * 0.52);
      jawParts.push(c);
    }
    const pivot = V(0, -0.45, -0.3), jawGeo = mergeGeometries(jawParts);
    jawGeo.translate(-pivot.x, -pivot.y, -pivot.z);
    const samples = [];
    for (let i = 0; i < 500; i++) samples.push(V(0, 0, 0).fromBufferAttribute(p, (Math.random() * p.count) | 0));
    skullCache = { head: mergeGeometries(parts), jaw: jawGeo, pivot, samples, hornTips: [V(1.12, 2.2, 0.95), V(-1.12, 2.2, 0.95)] };
    return skullCache;
  }

  // ---------------- dragon parts (head space: x forward, y up, z to the side) ----------------
  let dragonCache = null;
  function dragonParts() {
    if (dragonCache) return dragonCache;
    const blob = (sx, sy, sz, x, y, z, w = 22, h = 16) => { const g = new THREE.SphereGeometry(1, w, h); g.scale(sx, sy, sz); g.translate(x, y, z); return g; };
    const head = [blob(80, 52, 58, 0, 8, 0), blob(95, 30, 40, 95, -4, 0), blob(40, 22, 34, 150, -2, 0)];
    [1, -1].forEach(s => {
      head.push(blob(40, 14, 16, 50, 34, s * 30, 12, 8));                                                                                          // brow
      head.push(taperedTube(mirroredZ([[20, 40, 28], [-40, 85, 48], [-130, 105, 62], [-200, 95, 70]], s), 17, 0, 24, 8));                         // horns
      head.push(taperedTube(mirroredZ([[0, -20, 50], [-40, -40, 80], [-95, -45, 100]], s), 10, 0, 12, 6));                                        // cheek spikes
      head.push(taperedTube(mirroredZ([[175, -10, 20], [205, -30, 70], [185, -85, 120], [140, -120, 150]], s), 4, 0.6, 18, 5));                    // whiskers
      for (let i = 0; i < 6; i++) { const c = new THREE.ConeGeometry(4.5, 17, 5); c.rotateX(Math.PI); c.translate(62 + i * 20, -30, s * (32 - i * 3)); head.push(c); }
    });
    const jaw = [blob(90, 16, 34, 70, -6, 0)];
    [1, -1].forEach(s => { for (let i = 0; i < 5; i++) { const c = new THREE.ConeGeometry(4, 14, 5); c.translate(70 + i * 22, 8, s * (28 - i * 3)); jaw.push(c); } });

    // One wing, reaching toward +z: leading edge root -> elbow -> tip, scalloped trailing edge back to the body
    const root = [0, 0, 0], elbow = [-30, 40, 190], tip = [-90, 30, 470];
    const trail = [[-300, 0, 420], [-330, 0, 290], [-310, 0, 170], [-230, 0, 70], [-120, 0, 0]];
    const pos = [], uv = [];
    const add = q => { pos.push(q[0], q[1], q[2]); uv.push(-q[0] / 340, q[2] / 470); };
    const tri = (a, b, c) => { add(a); add(b); add(c); };
    const edge = [tip].concat(trail);
    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i], b = edge[i + 1];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2].map((m, k) => m + (elbow[k] - m) * 0.16);
      const hub = i < 3 ? elbow : root;
      tri(hub, a, mid); tri(hub, mid, b);
    }
    tri(root, elbow, trail[3]);
    const membrane = new THREE.BufferGeometry();
    membrane.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    membrane.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const bones = [taperedTube([root, elbow, tip], 12, 3, 20, 7)].concat(trail.slice(0, 3).map(t => taperedTube([elbow, t], 7, 1.5, 10, 5)));

    const spine = new THREE.ConeGeometry(1, 1, 6);
    spine.translate(0, 0.5, 0);
    dragonCache = {
      head: mergeGeometries(head), jaw: mergeGeometries(jaw), bones: mergeGeometries(bones), membrane, spine,
      jawPivot: V(30, -24, 0), mouth: V(195, -18, 0), eyes: [V(64, 32, 36), V(64, 32, -36)]
    };
    return dragonCache;
  }

  // Serpent body: N rings of M sides, rebuilt from the flight path every frame
  function bodyGeometry(N, M) {
    const count = N * (M + 1), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const uv = new Float32Array(count * 2), idx = [];
    for (let i = 0; i < N; i++) for (let j = 0; j <= M; j++) { const k = i * (M + 1) + j; uv[k * 2] = i / (N - 1); uv[k * 2 + 1] = j / M; }
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + M + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    g.setIndex(idx);
    return g;
  }

  function disposeTree(root, keep) {
    root.traverse(o => {
      if (o.material) [].concat(o.material).forEach(m => m.dispose());
      if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
    });
  }

  // ---------------- Hellfire ----------------
  P.goalHellfire = function (pos, team, n, painted) {
    const dark = painted && isDark(team);
    const vein = painted ? (dark ? team.clone().lerp(WHITE, 0.35) : team.clone().multiplyScalar(1.3)) : new THREE.Color(1.0, 0.32, 0.04).multiplyScalar(1.2);
    const glow = painted ? glowOf(team) : new THREE.Color(1, 0.42, 0.08);
    const fireCol = heat => (painted ? team.clone().lerp(WHITE, dark ? heat * 0.15 : heat * 0.45) : new THREE.Color(1, 0.2 + heat * 0.65, heat * 0.22));
    const model = skullModel(), scene = this.scene, S = 520, T_END = 3.9;
    const base = V(pos.x * 0.3, 0, pos.z + n.z * 720);

    const mat = moltenMaterial(vein);
    const rig = new THREE.Group(), pose = new THREE.Group();
    const head = new THREE.Mesh(model.head, mat), jaw = new THREE.Mesh(model.jaw, mat);
    jaw.position.copy(model.pivot);
    const eyes = [-1, 1].map(s => { const e = glowSprite(glowOf(vein).lerp(WHITE, 0.3)); e.position.set(s * 0.36, 0.02, 0.66); return e; });
    const mouthGlow = glowSprite(glow);
    mouthGlow.position.set(0, -0.62, 0.45);
    pose.add(head, jaw, mouthGlow, ...eyes);
    rig.add(pose);
    rig.scale.setScalar(S);
    rig.rotation.y = n.z > 0 ? 0 : Math.PI;
    rig.position.set(base.x, -900, base.z);
    scene.add(rig);

    const crater = fxDisc(CRATER_FRAG, glow, 1500);
    crater.rotation.x = -Math.PI / 2;
    crater.position.set(base.x, 7, base.z);
    scene.add(crater);

    this.burstFlash(V(base.x, 200, base.z), glow.clone().lerp(WHITE, 0.4), 3200, 0.5, 1);
    this.shockRing(V(base.x, 8, base.z), WORLD_UP, glow, 3000, 1.2, 0.2, 0.9);
    this.energyShell(V(base.x, 150, base.z), glow, 1600, 0.8, 0.9);
    this.godRays(V(base.x, 250, base.z), glow, 16, 2800, 1.4, WORLD_UP);
    this.floorScorch(base.x, base.z, glow, 2300, 4.8);
    this.lightFlash(V(base.x, 300, base.z), glow, 6);
    this.addShake(2.4);
    this.pulseBloom(1.4);

    const tmp = V(0, 0, 0), mouth = V(0, 0, 0), dir = V(0, 0, 0), q = new THREE.Quaternion();
    let flames = 0, breath = 0, embers = 0, eyesLit = false, roared = false;
    for (let m = 0; m < 10; m++) this.later(1.2 + m * 0.11, () => this.hellMeteor(pose.localToWorld(model.hornTips[m % 2].clone()), n, fireCol, glow, dark));

    this.addActor((act, dt) => {
      const t = act.t;
      mat.uniforms.time.value = t;
      crater.material.uniforms.time.value = t;
      crater.material.uniforms.fade.value = smooth(0, 0.25, t) * (1 - smooth(3.1, T_END, t));
      crater.scale.setScalar(0.4 + 0.6 * smooth(0, 0.5, t));

      // Rise out of the crater with an overshoot, then hover and rear back while roaring
      const k = clamp01(t / 0.8), c1 = 1.6, ease = 1 + (c1 + 1) * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
      rig.position.y = -900 + 1460 * ease + Math.sin(t * 2.2) * 25 * smooth(0.8, 1.2, t);
      const open = smooth(0.95, 1.2, t) * (1 - smooth(2.05, 2.35, t));
      pose.rotation.x = -0.16 * open + Math.sin(t * 1.3) * 0.03;
      pose.rotation.z = Math.sin(t * 1.7) * 0.05;
      jaw.rotation.x = 0.62 * open + 0.05 * Math.sin(t * 25) * open;
      mat.uniforms.glow.value = 0.25 + 0.75 * smooth(0.4, 1.0, t) + 0.8 * open;

      const eyeK = smooth(0.55, 0.9, t) * (1 - smooth(2.9, 3.3, t));
      eyes.forEach(e => { e.material.opacity = eyeK; e.scale.setScalar(0.42 + 0.3 * open + 0.04 * Math.sin(t * 30)); });
      mouthGlow.material.opacity = open;
      mouthGlow.scale.setScalar(0.9 + 0.3 * Math.sin(t * 20));
      rig.updateMatrixWorld(true);
      if (!eyesLit && t > 0.72) {
        eyesLit = true;
        eyes.forEach(e => this.lensFlare(e.getWorldPosition(V(0, 0, 0)), glow, 2800, 0.55));
        this.pulseBloom(0.6);
      }

      // The roar: a torrent of fire out of the jaws
      if (open > 0.5) {
        mouth.set(0, -0.72, 0.8);
        pose.localToWorld(mouth);
        dir.set(0, -0.12, 1).applyQuaternion(pose.getWorldQuaternion(q)).normalize();
        if (!roared) {
          roared = true;
          this.addShake(1.5);
          this.pulseBloom(1.2);
          this.energyShell(mouth.clone(), glow, 1000, 0.5, 0.9);
          this.lightFlash(mouth, glow, 5);
        }
        breath += dt * 260;
        for (; breath >= 1; breath--) {
          const v = dir.clone().multiplyScalar(rand(1400, 2700)).add(V(rand(-240, 240), rand(-120, 280), rand(-240, 240)));
          this.paintEmit(dark, mouth.x, mouth.y, mouth.z, v.x, v.y, v.z, rand(0.5, 1.0), rand(120, 280), fireCol(Math.random()), { drag: 1.6, grow: 1.2, gravity: -250, opacity: 0.85 });
        }
        if (Math.random() < 0.7) this.fx().streaks.emit(mouth, dir.clone().multiplyScalar(rand(1800, 3000)).add(randVec(260)), fireCol(1), rand(0.3, 0.55), { width: rand(26, 48), stretch: 0.12, drag: 1.5 });
      }

      // Flames licking up around the skull from the crater rim
      flames += dt * (t < 3.2 ? 200 : 40);
      for (; flames >= 1; flames--) {
        const a = rand(0, 6.28), r = rand(450, 950) * (0.4 + 0.6 * smooth(0, 0.5, t));
        this.paintEmit(dark, base.x + Math.cos(a) * r, 20, base.z + Math.sin(a) * r * 0.8, rand(-80, 80), rand(700, 1500), rand(-80, 80),
          rand(0.4, 0.9), rand(120, 240), fireCol(Math.random()), { drag: 1.4, grow: -0.3, gravity: -150, opacity: 0.8 });
      }

      // Crumble into embers
      const dis = smooth(2.75, 3.65, t);
      mat.uniforms.dissolve.value = dis * 1.05;
      if (dis > 0 && dis < 1) {
        embers += dt * 520;
        for (; embers >= 1; embers--) {
          tmp.copy(model.samples[(Math.random() * model.samples.length) | 0]);
          pose.localToWorld(tmp);
          this.paintEmit(dark, tmp.x, tmp.y, tmp.z, rand(-160, 160), rand(100, 650), rand(-160, 160), rand(0.8, 1.6), rand(22, 44), fireCol(Math.random()), { drag: 0.8, gravity: -120, twinkle: 1 });
        }
      }

      if (t >= T_END) {
        scene.remove(rig, crater);
        disposeTree(rig, new Set([model.head, model.jaw]));
        crater.geometry.dispose();
        crater.material.dispose();
        return false;
      }
      return true;
    });
  };

  // A flaming meteor flung from a horn tip onto the pitch
  P.hellMeteor = function (start, n, fireCol, glow, dark) {
    const p = start.clone(), vel = V(rand(-1300, 1300), rand(500, 1100), 0).addScaledVector(n, rand(800, 1800));
    const rock = glowSprite(glow.clone().lerp(WHITE, 0.3));
    rock.material.opacity = 1;
    rock.scale.setScalar(200);
    this.scene.add(rock);
    this.addActor((act, dt) => {
      vel.y -= 1500 * dt;
      p.addScaledVector(vel, dt);
      rock.position.copy(p);
      this.fx().streaks.emit(p, vel.clone().multiplyScalar(0.25), fireCol(Math.random()), 0.35, { width: 46, stretch: 0.25, drag: 3 });
      this.paintEmit(dark, p.x, p.y, p.z, rand(-50, 50), rand(0, 80), rand(-50, 50), rand(0.4, 0.8), rand(70, 120), fireCol(Math.random()), { grow: 1, drag: 1.5, opacity: 0.6 });
      if (p.y > 20 && act.t < 3) return true;
      p.y = 20;
      this.scene.remove(rock);
      rock.material.dispose();
      this.burstFlash(p, glow, 800, 0.3, 0.9);
      this.shockRing(V(p.x, 7, p.z), WORLD_UP, glow, 600, 0.5, 0.2, 0.8);
      this.floorScorch(p.x, p.z, glow, 380, 2.2);
      this.streakBurst(p, glow, 36, [300, 1000], { minY: 0.2, gravity: 1200, life: [0.4, 0.8], width: [8, 16] });
      this.addShake(0.3);
      return false;
    });
  };

  // ---------------- Dueling Dragons ----------------
  P.goalDragons = function (pos, team, n, painted) {
    const parts = dragonParts(), scene = this.scene;
    const colors = painted ? [team.clone(), team.clone().offsetHSL(0, 0, isDark(team) ? 0.12 : 0.15)] : [team.clone(), new THREE.Color(1, 0.55, 0.1)];
    const origin = V(0, 0, pos.z), N = 64, M = 12, R = 110, LAG = 0.75, CLASH = 2.85, T_END = 3.6, SIZE = 1.45;
    const path = (phase, t, out) => {
      t = Math.max(t, 0);
      const conv = 1 - smooth(2.15, CLASH, t), ang = phase + t * 3.4, radius = (700 + 220 * Math.sin(t * 1.9)) * conv;
      out.copy(origin).addScaledVector(n, 300 + t * 560);
      out.x += Math.cos(ang) * radius;
      out.y = 160 + t * 540 + Math.sin(ang) * radius * 0.55;
      return out;
    };

    // Portal they burst out of
    const portalColor = glowOf(colors[0]).lerp(glowOf(colors[1]), 0.5);
    const portal = fxDisc(PORTAL_FRAG, portalColor, 750);
    portal.position.copy(origin).addScaledVector(n, 260).setY(520);
    portal.lookAt(portal.position.clone().add(n));
    scene.add(portal);
    this.burstFlash(portal.position, portalColor.clone().lerp(WHITE, 0.4), 2600, 0.45, 1);
    this.shockRing(V(pos.x, 8, pos.z + n.z * 300), WORLD_UP, portalColor, 2600, 1.0, 0.12, 0.8);
    this.godRays(portal.position, portalColor, 14, 2200, 1.2, n);
    this.addShake(1.6);
    this.pulseBloom(1.0);

    const keep = new Set([parts.head, parts.jaw, parts.bones, parts.membrane, parts.spine]);
    const dragons = colors.map((color, d) => {
      const dark = isDark(color), glow = glowOf(color).multiplyScalar(dark ? 1 : 1.25);
      const belly = dark ? color.clone().lerp(WHITE, 0.25) : color.clone().lerp(new THREE.Color(1, 0.92, 0.7), 0.55);
      const mat = scaleMaterial(color, belly, glow), wingMat = membraneMaterial(glow);
      const group = new THREE.Group();
      const bodyGeo = bodyGeometry(N, M), body = new THREE.Mesh(bodyGeo, mat);
      body.frustumCulled = false;
      const head = new THREE.Group(), jaw = new THREE.Mesh(parts.jaw, mat);
      jaw.position.copy(parts.jawPivot);
      head.add(new THREE.Mesh(parts.head, mat), jaw);
      const eyes = parts.eyes.map(e => { const s = glowSprite(glow.clone().lerp(WHITE, 0.5)); s.position.copy(e); s.scale.setScalar(70); head.add(s); return s; });
      const spines = [];
      for (let i = 0; i < 18; i++) { const s = new THREE.Mesh(parts.spine, mat); spines.push(s); group.add(s); }
      const wings = [1, -1].map(side => {
        const mount = new THREE.Group(), flap = new THREE.Group();
        flap.add(new THREE.Mesh(parts.bones, mat), new THREE.Mesh(parts.membrane, wingMat));
        flap.scale.z = side;
        mount.add(flap);
        group.add(mount);
        return { mount, flap, side };
      });
      group.add(body, head);
      scene.add(group);
      return { phase: d * Math.PI, color, glow, dark, mat, wingMat, group, bodyGeo, head, jaw, eyes, spines, wings, breath: 0, embers: 0, rings: [] };
    });

    const p = V(0, 0, 0), a = V(0, 0, 0), b = V(0, 0, 0), f = V(0, 0, 0), side = V(0, 0, 0), up = V(0, 0, 0), off = V(0, 0, 0);
    const basis = new THREE.Matrix4();
    // Center and frame of the body at s (0 head, 1 tail) at time t
    const frame = (dr, t, s, out) => {
      const tt = t - s * LAG;
      path(dr.phase, tt, p);
      path(dr.phase, Math.max(tt, 0) + 0.02, a);
      path(dr.phase, Math.max(tt - 0.02, 0), b);
      f.subVectors(a, b);
      if (f.lengthSq() < 1e-6) f.copy(n);
      f.normalize();
      side.crossVectors(f, WORLD_UP);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      up.crossVectors(side, f);
      const profile = s < 0.08 ? 0.55 + 0.45 * s / 0.08 : Math.pow(1 - (s - 0.08) / 0.92, 0.65);
      out.r = R * profile * (1 + 0.06 * Math.sin(s * 60)) * smooth(0, 0.12, tt);
      out.p = p.clone(); out.f = f.clone(); out.up = up.clone(); out.side = side.clone();
      return out;
    };

    let clashed = false;
    this.addActor((act, dt) => {
      const t = act.t;
      portal.material.uniforms.time.value = t;
      portal.material.uniforms.fade.value = smooth(0, 0.2, t) * (1 - smooth(1.0, 1.7, t));
      portal.scale.setScalar(0.3 + 0.7 * smooth(0, 0.35, t));
      const dissolve = smooth(CLASH - 0.05, T_END - 0.1, t) * 1.05;

      dragons.forEach(dr => {
        dr.mat.uniforms.time.value = t;
        dr.mat.uniforms.dissolve.value = dissolve;
        dr.wingMat.uniforms.time.value = t;
        const pos3 = dr.bodyGeo.attributes.position, nor3 = dr.bodyGeo.attributes.normal, fr = {};
        const spineStep = Math.floor(N * 0.8 / dr.spines.length);
        for (let i = 0; i < N; i++) {
          const s = i / (N - 1);
          frame(dr, t, s, fr);
          for (let j = 0; j <= M; j++) {
            const ang = (j / M) * Math.PI * 2, k = i * (M + 1) + j;
            off.copy(fr.up).multiplyScalar(Math.cos(ang)).addScaledVector(fr.side, Math.sin(ang) * 0.92);
            nor3.setXYZ(k, off.x, off.y, off.z);
            pos3.setXYZ(k, fr.p.x + off.x * fr.r, fr.p.y + off.y * fr.r, fr.p.z + off.z * fr.r);
          }
          const si = i / spineStep - 1;
          if (i % spineStep === 0 && si >= 0 && si < dr.spines.length) {
            const sp = dr.spines[si], dirSp = fr.up.clone().addScaledVector(fr.f, -0.6).normalize();
            sp.position.copy(fr.p).addScaledVector(fr.up, fr.r * 0.8);
            sp.quaternion.setFromUnitVectors(WORLD_UP, dirSp);
            sp.scale.set(fr.r * 0.22 + 0.01, fr.r * 1.2 * (1 - s * 0.6) + 0.01, fr.r * 0.22 + 0.01);
          }
          if (i === 9) {
            dr.wings.forEach(w => {
              w.mount.position.copy(fr.p).addScaledVector(fr.up, fr.r * 0.5);
              basis.makeBasis(fr.f, fr.up, fr.side);
              w.mount.quaternion.setFromRotationMatrix(basis);
              const beat = Math.sin(t * 8 + dr.phase) * 0.75 + 0.25, grow = smooth(0.25, 0.8, t);
              w.flap.rotation.x = -w.side * beat;
              w.mount.scale.setScalar(0.01 + grow * 1.1 * SIZE);
              dr.wingMat.uniforms.opacity.value = grow * (1 - smooth(CLASH, T_END - 0.2, t));
            });
          }
          if (i === 0) {
            dr.head.position.copy(fr.p).addScaledVector(fr.f, R * 0.2);
            basis.makeBasis(fr.f, fr.up, fr.side);
            dr.head.quaternion.setFromRotationMatrix(basis);
            dr.head.scale.setScalar(0.01 + 1.15 * SIZE * smooth(0, 0.18, t));
            dr.headF = fr.f.clone();
          }
        }
        pos3.needsUpdate = nor3.needsUpdate = true;
        dr.bodyGeo.computeBoundingSphere();

        // Jaws open to breathe fire in two bursts and roar at the clash
        const breathing = (t > 0.85 && t < 1.55) || (t > 1.9 && t < 2.45);
        const open = breathing ? 1 : t > CLASH - 0.35 && t < CLASH ? 1 : 0;
        dr.jawOpen = (dr.jawOpen || 0) + (open - (dr.jawOpen || 0)) * Math.min(dt * 12, 1);
        dr.jaw.rotation.z = -0.55 * dr.jawOpen;
        dr.eyes.forEach(e => { e.material.opacity = smooth(0.1, 0.4, t) * (1 - dissolve); e.scale.setScalar(55 + 30 * dr.jawOpen); });
        dr.group.updateMatrixWorld(true);
        if (breathing && dr.headF) {
          const mouth = dr.head.localToWorld(parts.mouth.clone()), dir = dr.headF.clone().add(V(0, -0.15, 0)).normalize();
          dr.breath += dt * 150;
          for (; dr.breath >= 1; dr.breath--) {
            const v = dir.clone().multiplyScalar(rand(1200, 2200)).add(randVec(220)), heat = Math.random();
            this.paintEmit(dr.dark, mouth.x, mouth.y, mouth.z, v.x, v.y, v.z, rand(0.4, 0.8), rand(90, 200), dr.color.clone().lerp(WHITE, heat * (dr.dark ? 0.15 : 0.5)), { drag: 1.8, grow: 1.3, opacity: 0.85 });
          }
          if (Math.random() < 0.5) this.fx().streaks.emit(mouth, dir.clone().multiplyScalar(rand(1600, 2600)).add(randVec(200)), dr.glow.clone().lerp(WHITE, 0.3), rand(0.3, 0.5), { width: rand(22, 36), stretch: 0.12, drag: 2 });
        }
        // Embers shed along the body
        dr.embers += dt * 90 * (1 - dissolve * 0.5);
        for (; dr.embers >= 1; dr.embers--) {
          const k = ((Math.random() * N) | 0) * (M + 1) + ((Math.random() * M) | 0);
          this.paintEmit(dr.dark, pos3.getX(k), pos3.getY(k), pos3.getZ(k), rand(-90, 90), rand(-40, 160), rand(-90, 90), rand(0.6, 1.2), rand(20, 42), dr.glow, { drag: 1.2, gravity: 100, twinkle: 1 });
        }
      });

      // The clash where they meet
      if (!clashed && t >= CLASH) {
        clashed = true;
        const top = path(0, CLASH, V(0, 0, 0)), glow = portalColor.clone().lerp(WHITE, 0.2);
        this.burstFlash(top, glow.clone().lerp(WHITE, 0.5), 5200, 0.5, 1);
        this.energyShell(top, dragons[0].color, 2000, 0.9, 1.2);
        this.energyShell(top, dragons[1].color, 1300, 0.7, 1.0);
        this.godRays(top, glow, 20, 3000, 1.3);
        this.shockRing(top, n, glow, 3600, 1.0, 0.06, 0.9);
        dragons.forEach(dr => this.streakBurst(top, dr.glow, 180, [1000, 2600], { gravity: 500, life: [0.6, 1.4], width: [14, 28] }));
        this.lensFlare(top, WHITE, 6500, 0.8);
        this.lightFlash(top, glow, 6);
        this.addShake(2.2);
        this.pulseBloom(1.8);
        if (this.onFirework) this.onFirework(top, 1);
      }

      if (t >= T_END) {
        scene.remove(portal);
        portal.geometry.dispose();
        portal.material.dispose();
        dragons.forEach(dr => { scene.remove(dr.group); disposeTree(dr.group, keep); });
        return false;
      }
      return true;
    });
  };

  // Build the models and compile their shaders ahead of time so the first goal doesn't hitch
  function prewarm(renderer, camera, type) {
    if (type !== 'hellfire' && type !== 'dragons') return;
    try {
      const scene = new THREE.Scene(), color = new THREE.Color(1, 0.5, 0.1);
      if (type === 'hellfire') {
        const m = skullModel(), mat = moltenMaterial(color);
        scene.add(new THREE.Mesh(m.head, mat), fxDisc(CRATER_FRAG, color, 10));
      } else {
        const d = dragonParts(), mat = scaleMaterial(color, color, color);
        scene.add(new THREE.Mesh(d.head, mat), new THREE.Mesh(bodyGeometry(4, 4), mat), new THREE.Mesh(d.membrane, membraneMaterial(color)), fxDisc(PORTAL_FRAG, color, 10));
      }
      renderer.compile(scene, camera);
    } catch (e) { console.warn('Explosion model prewarm failed', e); }
  }

  return { prewarm, skullModel, dragonParts };
})();
