// Arenas: the same standard soccar field in different Rocket League-style settings. Each map overrides the
// stadium palette (sky, sun, fog, turf, walls, crowd, ground) and adds its own scenery outside the stands,
// all built from geometry at runtime. Every map shares the exact same collision, so nothing changes physically.
window.Game = window.Game || {};

Game.Maps = (function () {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const col = hex => new THREE.Color(hex);

  // Seeded random so scenery is laid out the same every time
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function canvasTexture(w, h, draw, repeat) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    t.anisotropy = 8;
    return t;
  }

  // Merges geometries, painting each with a flat vertex colour
  function mergeColored(list) {
    const pos = [], nor = [], colr = [];
    list.forEach(({ geo, color }) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      if (!g.attributes.normal) g.computeVertexNormals();
      const c = col(color), P = g.attributes.position, N = g.attributes.normal;
      for (let i = 0; i < P.count; i++) {
        pos.push(P.getX(i), P.getY(i), P.getZ(i));
        nor.push(N.getX(i), N.getY(i), N.getZ(i));
        colr.push(c.r, c.g, c.b);
      }
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    return out;
  }

  // Scatters an instanced mesh on a ring around the arena
  function scatter(root, geometry, material, count, rMin, rMax, seed, sizeFn, opts) {
    opts = opts || {};
    const r = rng(seed), mesh = new THREE.InstancedMesh(geometry, material, count), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2, d = rMin + (rMax - rMin) * Math.sqrt(r());
      const x = Math.cos(a) * d * (opts.stretchX || 1), z = Math.sin(a) * d * (opts.stretchZ || 1.3);
      q.setFromAxisAngle(V(0, 1, 0), r() * Math.PI * 2);
      sizeFn(s, r, d);
      m.compose(V(x, opts.y || 0, z), q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  }

  // ---------------- scenery pieces ----------------
  function tree(color, trunk) {
    const t = new THREE.CylinderGeometry(0.05, 0.08, 0.4, 6).translate(0, 0.2, 0);
    const c1 = new THREE.ConeGeometry(0.42, 0.7, 7).translate(0, 0.65, 0);
    const c2 = new THREE.ConeGeometry(0.32, 0.55, 7).translate(0, 0.95, 0);
    return mergeColored([{ geo: t, color: trunk || 0x5a3d25 }, { geo: c1, color }, { geo: c2, color: col(color).offsetHSL(0, 0, 0.06) }]);
  }

  function blossomTree() {
    const parts = [{ geo: new THREE.CylinderGeometry(0.05, 0.09, 0.6, 6).translate(0, 0.3, 0), color: 0x4a3226 }];
    const r = rng(7);
    for (let i = 0; i < 6; i++) {
      parts.push({ geo: new THREE.IcosahedronGeometry(0.22 + r() * 0.12, 1).translate((r() - 0.5) * 0.5, 0.6 + r() * 0.35, (r() - 0.5) * 0.5), color: i % 3 ? 0xf6a9c8 : 0xffd1e3 });
    }
    return mergeColored(parts);
  }

  function palm() {
    const parts = [];
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.CylinderGeometry(0.035, 0.045, 0.2, 6).translate(0, 0.1, 0);
      seg.rotateZ(-0.05 * i).translate(i * i * 0.004, i * 0.19, 0);
      parts.push({ geo: seg, color: i % 2 ? 0x8a6a43 : 0x7a5b37 });
    }
    for (let k = 0; k < 7; k++) {
      const leaf = new THREE.ConeGeometry(0.07, 0.75, 4);
      leaf.scale(1, 1, 0.25).rotateZ(-Math.PI / 2 + 0.5).translate(0.32, -0.12, 0).rotateY((k / 7) * Math.PI * 2).translate(0.1, 1.18, 0);
      parts.push({ geo: leaf, color: k % 2 ? 0x2f8a3c : 0x3a9a45 });
    }
    return mergeColored(parts);
  }

  function mountain(seed, snowLine) {
    const g = new THREE.ConeGeometry(1, 1, 9, 6), P = g.attributes.position, r = rng(seed), colr = [];
    for (let i = 0; i < P.count; i++) {
      const y = P.getY(i) + 0.5, k = 1 + (r() - 0.5) * 0.35 * (1 - y);
      P.setX(i, P.getX(i) * k); P.setZ(i, P.getZ(i) * k); P.setY(i, P.getY(i) + (r() - 0.5) * 0.04);
    }
    g.translate(0, 0.5, 0);
    const out = g.toNonIndexed();
    out.computeVertexNormals();
    const Q = out.attributes.position;
    for (let i = 0; i < Q.count; i++) {
      const c = Q.getY(i) > snowLine + (r() - 0.5) * 0.06 ? col(0xf2f5f7) : col(0x5d6b5a).lerp(col(0x7c8378), Q.getY(i));
      colr.push(c.r, c.g, c.b);
    }
    out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    return out;
  }

  function pagoda(root, x, z, scale, rotation) {
    const g = new THREE.Group(), wall = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.8 }), roof = new THREE.MeshStandardMaterial({ color: 0x2d2a2e, roughness: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.4, 0.5), toneMapped: false });
    let y = 0;
    for (let i = 0; i < 5; i++) {
      const w = 1 - i * 0.15, h = 0.45;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), wall);
      body.position.y = y + h / 2;
      g.add(body);
      const lit = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.4, h * 0.35), glow);
      lit.position.set(0, y + h * 0.5, w / 2 + 0.005);
      g.add(lit);
      const r = new THREE.Mesh(new THREE.ConeGeometry(w * 0.95, 0.28, 4, 1, true), roof);
      r.rotation.y = Math.PI / 4;
      r.position.y = y + h + 0.12;
      g.add(r);
      y += h + 0.16;
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.03, 0.6, 6), roof);
    spire.position.y = y + 0.3;
    g.add(spire);
    g.scale.setScalar(scale);
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    root.add(g);
  }

  function beams(root, anims, color, count, radius, height) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: color } },
      vertexShader: 'varying float vH; void main() { vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vH; void main() { gl_FragColor = vec4(color, (1.0 - vH) * 0.22); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const geo = new THREE.CylinderGeometry(900, 60, height, 16, 1, true).translate(0, height / 2, 0);
    const list = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2, beam = new THREE.Mesh(geo, mat);
      beam.position.set(Math.cos(a) * radius, 5500, Math.sin(a) * radius * 1.35);
      root.add(beam);
      list.push({ beam, phase: i * 1.7 });
    }
    anims.push((dt, t) => list.forEach(b => { b.beam.rotation.set(Math.sin(t * 0.4 + b.phase) * 0.45, 0, Math.cos(t * 0.33 + b.phase) * 0.45); }));
  }

  // ---------------- maps ----------------
  const MAPS = [
    {
      id: 'dfh', name: 'DFH Stadium', desc: 'The classic arena: a packed bowl under a bright afternoon sky.', preview: ['#1b4f9c', '#6aa3dd', '#f6d2a2'],
      palette: {}
    },
    {
      id: 'mannfield', name: 'Mannfield', desc: 'Sunny countryside stadium surrounded by rolling green hills and forests.', preview: ['#2f7fd6', '#8cc4f0', '#4d8a3a'],
      palette: {
        open: true, sky: ['#2f7fd6', '#8cc4f0', '#e8f4ff'], sunColor: '#fff4d6', sunDir: [0.25, 0.75, -0.6], clouds: 0.9, fog: '#bcd8ee', fogNear: 22000, fogFar: 95000,
        grass: ['#4a9c3c', '#55a946'], goalTurf: '#43913a', wallBase: '#2a3346', standBase: '#1a2230', structure: '#dfe6ef', ground: '#4d8a3a',
        hemi: ['#f2f7ff', '#4f6b35', 0.6], sunI: 1.1
      },
      extras(root) {
        const hillMat = new THREE.MeshStandardMaterial({ color: 0x5d9a45, roughness: 1, flatShading: true });
        scatter(root, new THREE.SphereGeometry(1, 12, 8), hillMat, 26, 38000, 70000, 11, (s, r) => s.set(9000 + r() * 12000, 2500 + r() * 5000, 9000 + r() * 12000));
        const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
        scatter(root, tree(0x2f7a37), treeMat, 420, 15000, 40000, 3, (s, r) => s.setScalar(1500 + r() * 1800));
      }
    },
    {
      id: 'champions', name: "Champions Field", desc: 'Night-time championship venue with a starry sky and sweeping searchlights.', preview: ['#02040c', '#0a1636', '#6f4cff'],
      palette: {
        sky: ['#02040c', '#0a1636', '#1c2f5c'], sunColor: '#8fb0ff', sunDir: [-0.3, 0.5, 0.8], clouds: 0.12, stars: 1, fog: '#0b1426', fogNear: 25000, fogFar: 95000,
        grass: ['#2f7a34', '#378840'], goalTurf: '#2c7231', wallBase: '#1b1f3a', standBase: '#0d1020',
        crowd: ['#6f4cff', '#f2c14e', '#e8ecf2', '#2b6cd6', '#e0701e', '#3a2f6b', '#ffffff'], structure: '#15182a', ground: '#0b0e16',
        hemi: ['#9fb4ff', '#1a1f14', 0.45], sunI: 0.75
      },
      extras(root, T, anims) {
        beams(root, anims, new THREE.Color(0.75, 0.8, 1.2), 12, 11500, 26000);
        const trophy = new THREE.Group(), gold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1, roughness: 0.25, emissive: 0x5a3a00 });
        trophy.add(new THREE.Mesh(new THREE.CylinderGeometry(900, 1200, 900, 24), gold));
        const cup = new THREE.Mesh(new THREE.SphereGeometry(1400, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), gold);
        cup.position.y = 2600; cup.rotation.x = Math.PI;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(250, 250, 1600, 12), gold);
        stem.position.y = 1300;
        trophy.add(cup, stem);
        [-1, 1].forEach(s => { const h = new THREE.Mesh(new THREE.TorusGeometry(700, 120, 8, 20, Math.PI), gold); h.position.set(s * 1300, 2500, 0); h.rotation.z = s * Math.PI / 2; trophy.add(h); });
        [-1, 1].forEach(s => { const t = trophy.clone(); t.position.set(0, 9000, s * 16000); root.add(t); anims.push((dt, time) => { t.rotation.y = time * 0.3; }); });
      }
    },
    {
      id: 'neotokyo', name: 'Neo Tokyo', desc: 'A neon megacity at night: glowing skyscrapers, billboards and flying traffic.', preview: ['#07020f', '#2a0b3a', '#ff3c9a'],
      palette: {
        open: true, sky: ['#07020f', '#2a0b3a', '#ff3c9a'], sunColor: '#ff5fbf', sunDir: [0, 0.08, -1], clouds: 0.2, stars: 0.35, fog: '#1a0826', fogNear: 24000, fogFar: 110000,
        grass: ['#1f5f45', '#24694c'], goalTurf: '#1b5540', line: '#b8f6ff', wallBase: '#1c1030', standBase: '#0e0716',
        crowd: ['#ff3c9a', '#39e6ff', '#b36bff', '#ffffff', '#ffd23f', '#1e1030'], structure: '#140c22', ground: '#07050d',
        hemi: ['#b98cff', '#15101a', 0.5], sunI: 0.6
      },
      extras(root, T, anims) {
        const windows = canvasTexture(64, 256, (ctx, w, h) => {
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
          const r = rng(5), hues = ['#ffe8b0', '#9fe8ff', '#ff9fd6', '#ffffff'];
          for (let y = 4; y < h; y += 8) for (let x = 4; x < w; x += 8) if (r() < 0.45) { ctx.fillStyle = hues[(r() * hues.length) | 0]; ctx.fillRect(x, y, 5, 4); }
        }, [3, 6]);
        const tower = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
        const mat = new THREE.MeshStandardMaterial({ color: 0x0c0a16, roughness: 0.4, metalness: 0.6, emissive: 0xffffff, emissiveMap: windows, emissiveIntensity: 0.9 });
        scatter(root, tower, mat, 180, 17000, 52000, 21, (s, r, d) => s.set(1800 + r() * 3000, 6000 + r() * 26000 * (1.2 - d / 60000), 1800 + r() * 3000));
        const signs = [['NEO', '#ff3c9a'], ['TOKYO', '#39e6ff'], ['BOOST', '#ffd23f'], ['CAR BALL', '#b36bff'], ['GOAL!', '#ff3c9a'], ['SUPERSONIC', '#39e6ff']];
        const r = rng(9);
        for (let i = 0; i < 14; i++) {
          const [text, color] = signs[i % signs.length];
          const tex = canvasTexture(512, 128, (ctx, w, h) => {
            ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.strokeRect(6, 6, w - 12, h - 12);
            ctx.font = 'italic 900 78px Segoe UI, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.shadowColor = color; ctx.shadowBlur = 24; ctx.fillStyle = color; ctx.fillText(text, w / 2, h / 2 + 4);
          });
          const sign = new THREE.Mesh(new THREE.PlaneGeometry(7000, 1750), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true, side: THREE.DoubleSide }));
          const a = (i / 14) * Math.PI * 2 + r() * 0.2, d = 16500 + r() * 5000;
          sign.position.set(Math.cos(a) * d, 7000 + r() * 9000, Math.sin(a) * d * 1.3);
          sign.lookAt(0, sign.position.y, 0);
          root.add(sign);
        }
        // Flying traffic
        const car = new THREE.BoxGeometry(260, 80, 120), lights = [];
        for (let i = 0; i < 40; i++) {
          const m = new THREE.Mesh(car, new THREE.MeshBasicMaterial({ color: i % 2 ? new THREE.Color(2, 0.4, 1.2) : new THREE.Color(0.5, 1.8, 2.2), toneMapped: false }));
          root.add(m);
          lights.push({ m, r: 15000 + (i % 5) * 3000, h: 9000 + (i % 7) * 1800, speed: (i % 2 ? 1 : -1) * (0.05 + (i % 4) * 0.015), phase: i * 0.7 });
        }
        anims.push((dt, t) => lights.forEach(l => {
          const a = l.phase + t * l.speed;
          l.m.position.set(Math.cos(a) * l.r, l.h, Math.sin(a) * l.r * 1.3);
          l.m.rotation.y = -a;
        }));
      }
    },
    {
      id: 'salty', name: 'Salty Shores', desc: 'Seaside arena at sunset with palm trees, sand and a glittering ocean.', preview: ['#3a5ea8', '#f08a5d', '#ffd08a'],
      palette: {
        open: true, sky: ['#3a5ea8', '#f08a5d', '#ffd08a'], sunColor: '#ffb46b', sunDir: [0.1, 0.12, -1], clouds: 0.6, fog: '#f2b98c', fogNear: 22000, fogFar: 95000,
        grass: ['#6aa84f', '#74b358'], goalTurf: '#62a048', wallBase: '#3b3346', standBase: '#2a2230', structure: '#e9dcc6', ground: '#e3c894',
        hemi: ['#ffe2c4', '#8a7250', 0.65], sunI: 1.05
      },
      extras(root, T, anims) {
        const time = { value: 0 };
        const sun = new THREE.Vector3(...T.sunDir).normalize();
        const ocean = new THREE.Mesh(new THREE.RingGeometry(26000, 160000, 96, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
          uniforms: { time, sunDir: { value: sun }, deep: { value: col('#1d4f7a') }, shallow: { value: col('#3fa6b8') }, sunColor: { value: col(T.sunColor) }, fogColor: { value: col(T.fog) } },
          vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
          fragmentShader: `
            uniform float time; uniform vec3 sunDir; uniform vec3 deep; uniform vec3 shallow; uniform vec3 sunColor; uniform vec3 fogColor; varying vec3 vW;
            void main() {
              float d = length(vW.xz);
              vec2 p = vW.xz * 0.0006;
              float w = sin(p.x * 3.0 + time * 0.8) * 0.5 + sin(p.y * 2.3 - time * 0.6) * 0.5 + sin((p.x + p.y) * 7.0 + time * 1.7) * 0.25;
              vec3 n = normalize(vec3(cos(p.x * 3.0 + time * 0.8) * 0.12, 1.0, cos(p.y * 2.3 - time * 0.6) * 0.12));
              vec3 view = normalize(cameraPosition - vW);
              float spec = pow(max(dot(reflect(-sunDir, n), view), 0.0), 60.0);
              vec3 c = mix(shallow, deep, smoothstep(26000.0, 60000.0, d)) * (0.85 + 0.15 * w) + sunColor * spec * 2.5;
              c += vec3(1.0) * smoothstep(0.92, 1.0, fract(d * 0.00035 - time * 0.12)) * (1.0 - smoothstep(26000.0, 32000.0, d)) * 0.6;
              c = mix(c, fogColor, smoothstep(40000.0, 150000.0, d));
              gl_FragColor = vec4(c, 1.0);
            }`
        }));
        ocean.position.y = -10;
        root.add(ocean);
        anims.push((dt, t) => { time.value = t; });
        const palmMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
        scatter(root, palm(), palmMat, 90, 14000, 24000, 17, (s, r) => s.setScalar(3200 + r() * 2600));
        const umbrellaGeo = mergeColored([{ geo: new THREE.CylinderGeometry(0.01, 0.01, 0.9, 5).translate(0, 0.45, 0), color: 0xdddddd }, { geo: new THREE.ConeGeometry(0.5, 0.25, 10, 1, true).translate(0, 0.95, 0), color: 0xff5a5a }]);
        scatter(root, umbrellaGeo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }), 40, 13000, 22000, 23, (s, r) => s.setScalar(1400 + r() * 500));
      }
    },
    {
      id: 'temple', name: 'Forbidden Temple', desc: 'Misty mountain temple grounds with pagodas and cherry blossom trees.', preview: ['#3b5566', '#8fa9a3', '#f6a9c8'],
      palette: {
        open: true, sky: ['#3b5566', '#8fa9a3', '#dfe3cf'], sunColor: '#ffe6b8', sunDir: [-0.6, 0.35, -0.7], clouds: 0.5, fog: '#a9bab0', fogNear: 14000, fogFar: 70000,
        grass: ['#4f8a45', '#5a954e'], goalTurf: '#4a8040', wallBase: '#3a2f2a', standBase: '#241c18',
        crowd: ['#b8322a', '#f6a9c8', '#e8ecf2', '#2d2a2e', '#f2c14e', '#3a6b4a'], structure: '#5a3a2a', ground: '#5f6f4c',
        hemi: ['#e6efe0', '#44503a', 0.6], sunI: 0.95
      },
      extras(root, T, anims) {
        const rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
        [1, 2, 3].forEach(k => scatter(root, mountain(k * 13, 0.72), rock, 7, 42000, 75000, k * 31, (s, r) => { const h = 16000 + r() * 22000; s.set(h * (0.9 + r() * 0.5), h, h * (0.9 + r() * 0.5)); }));
        pagoda(root, 0, 30000, 9000, 0);
        pagoda(root, 0, -30000, 9000, Math.PI);
        pagoda(root, -26000, 6000, 6000, Math.PI / 2);
        pagoda(root, 26000, -6000, 6000, -Math.PI / 2);
        const blossomMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
        scatter(root, blossomTree(), blossomMat, 160, 14000, 30000, 41, (s, r) => s.setScalar(2800 + r() * 2200));
        // Drifting petals
        const petals = new THREE.InstancedMesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshBasicMaterial({ color: 0xffc4dc, side: THREE.DoubleSide }), 300);
        const r = rng(3), data = [];
        for (let i = 0; i < 300; i++) data.push({ x: (r() - 0.5) * 30000, y: r() * 9000, z: (r() - 0.5) * 40000, s: 0.5 + r(), p: r() * 6 });
        petals.frustumCulled = false;
        root.add(petals);
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        anims.push((dt, t) => {
          data.forEach((d, i) => {
            d.y -= dt * 250 * d.s; d.x += dt * 300; if (d.y < 0) { d.y = 9000; d.x = (r() - 0.5) * 30000; }
            q.setFromEuler(e.set(t * d.s + d.p, t * 0.7 + d.p, 0));
            m.compose(V(d.x, d.y, d.z), q, V(1, 1, 1));
            petals.setMatrixAt(i, m);
          });
          petals.instanceMatrix.needsUpdate = true;
        });
      }
    }
  ];

  const get = id => MAPS.find(m => m.id === id) || MAPS[0];
  // 'random' picks any map
  const resolve = id => (id === 'random' || !MAPS.some(m => m.id === id) ? MAPS[(Math.random() * MAPS.length) | 0].id : id);

  return { MAPS, get, resolve };
})();
