// Arena and stadium visuals in a Rocket League style.
//  - Lower arena shell (ramps, padded walls, goal boxes, glowing goal rims) comes from the collision
//    SDF (Game.ArenaMesh) so it matches exactly; glass upper walls and ceiling are sweeps.
//  - All arena surfaces face inward and are front-face culled, so from behind a wall they vanish.
//  - Surface detail (turf stripes and grain, hex panels, LED bands, hex glass, goal nets) is
//    computed per pixel from world position, so nothing stretches.
//  - Stadium bowl, roof with floodlights, jumbotrons, a hanging scoreboard, a cloudy sky that
//    also lights the car's reflections, and Rocket League style boost pads.
// three.js coordinates: (x, y, z) = RL (x, z, y), uu.
window.Game = window.Game || {};

Game.Stadium = (function () {
  const G = Game.ArenaGeom;
  const H = G.height;
  const TIME = { value: 0 };

  const THEMES = {
    realistic: {
      sky: ['#1b4f9c', '#6aa3dd', '#f6d2a2'], sunColor: '#ffe7c2', sunDir: [-0.35, 0.42, -0.84], clouds: 0.75,
      fog: '#9db7d6', fogNear: 16000, fogFar: 70000,
      grass: ['#3d8a36', '#47953f'], goalTurf: '#357c30', line: 'rgba(255,255,255,0.92)', grain: 0.07,
      wallBase: '#262d3b', glassOpacity: 0.05,
      standBase: '#161c27', crowd: ['#2b6cd6', '#e0701e', '#e8ecf2', '#3a4558', '#b8322f', '#f2c14e', '#1f8a70', '#5b6b85', '#2b6cd6', '#e0701e'],
      structure: '#1b212c', hemi: ['#e4eeff', '#3b4a2c', 0.5], sunI: 1.0
    },
    arcade: {
      sky: ['#1f7ae0', '#6cc0ff', '#fff1c9'], sunColor: '#fff6d8', sunDir: [0.3, 0.6, -0.74], clouds: 1.0,
      fog: '#bfe3ff', fogNear: 20000, fogFar: 80000,
      grass: ['#52c64a', '#5ed455'], goalTurf: '#49b842', line: '#ffffff', grain: 0.02,
      wallBase: '#3c4a8f', glassOpacity: 0.09,
      standBase: '#28378a', crowd: ['#ff5d5d', '#ffd23f', '#3ddc97', '#4dabff', '#ffffff', '#ff8c2e', '#9b6bff'],
      structure: '#e9eef7', hemi: ['#ffffff', '#6d8f5a', 0.8], sunI: 0.9
    }
  };

  const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
  const col = hex => new THREE.Color(hex);

  function canvasTexture(w, h, draw, repeat) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.canvas = c;
    return tex;
  }

  // ---------------- per-pixel surface patterns ----------------
  const GLSL_COMMON = `
    uniform float uTime;
    varying vec3 vW;
    varying vec3 vN;
    float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float hexDist(vec2 p) {
      const vec2 s = vec2(1.0, 1.7320508);
      vec2 a = mod(p, s) - s * 0.5;
      vec2 b = mod(p - s * 0.5, s) - s * 0.5;
      vec2 g = dot(a, a) < dot(b, b) ? a : b;
      g = abs(g);
      return max(dot(g, normalize(s)), g.x);
    }
    vec2 wallUV() {
      vec3 n = normalize(vN);
      if (abs(n.y) > 0.75) return vW.xz;
      vec2 t = normalize(vec2(-n.z, n.x));
      return vec2(dot(vW.xz, t), vW.y);
    }
    float teamAmount() { return clamp(abs(vW.z) / 5120.0, 0.0, 1.0); }
    // team colours in linear space (sRGB #1a73ff blue, #ff7314 orange)
    vec3 teamColor() {
      vec3 tc = vW.z < 0.0 ? vec3(0.01, 0.17, 1.0) : vec3(1.0, 0.17, 0.007);
      return mix(vec3(0.7, 0.79, 1.0), tc, smoothstep(0.0, 0.3, teamAmount()));
    }
  `;

  const PATTERNS = {
    floor: {
      decl: 'uniform float uGrain;',
      code: `diffuseColor.rgb *= 1.0 - uGrain + 2.0 * uGrain * (0.55 * vnoise(vW.xz * 0.35) + 0.45 * vnoise(vW.xz * 0.05));`
    },
    turf: {
      decl: 'uniform vec3 uGrassA; uniform vec3 uGrassB; uniform float uGrain;',
      code: `
        float stripe = step(0.5, fract((vW.z + 5120.0) / 1024.0));
        vec3 g = mix(uGrassA, uGrassB, stripe);
        g *= 1.0 - uGrain + 2.0 * uGrain * (0.55 * vnoise(vW.xz * 0.35) + 0.45 * vnoise(vec2(vW.x + vW.z, vW.y) * 0.05));
        float h = clamp(vW.y / 256.0, 0.0, 1.0);
        g = mix(g, g * 0.75 + teamColor() * 0.12 * teamAmount(), h * h);
        diffuseColor.rgb = g;
      `
    },
    lower: {
      decl: 'uniform vec3 uWallBase;',
      code: `
        vec2 uv = wallUV();
        float t = teamAmount();
        vec3 tc = teamColor();
        vec3 base = mix(uWallBase, tc * 0.22 + uWallBase * 0.25, pow(t, 1.2) * 0.9);
        extraEmissive += tc * 0.12 * pow(t, 1.5);
        float su = abs(fract(uv.x / 640.0) - 0.5) * 640.0;
        float sv = abs(fract((uv.y - 280.0) / 216.0) - 0.5) * 216.0;
        float seam = max(step(314.0, su), step(104.0, sv));
        float hx = hexDist(uv / 70.0);
        float hexLine = smoothstep(0.43, 0.5, hx);
        base *= 1.0 - 0.28 * seam;
        base = mix(base, base * 1.35 + 0.02, hexLine * 0.4);
        diffuseColor.rgb = base;
        float band = smoothstep(915.0, 925.0, vW.y) * (1.0 - smoothstep(1025.0, 1035.0, vW.y));
        float wave = 0.5 + 0.5 * sin(uv.x * 0.005 - uTime * 3.0);
        float chev = step(0.55, fract(uv.x / 300.0 + abs(vW.y - 975.0) / 300.0 - uTime * 0.5));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.015), band);
        extraEmissive += tc * band * (0.25 + 0.75 * mix(wave, chev, 0.6)) * (0.35 + 0.75 * t);
        float trim = smoothstep(262.0, 268.0, vW.y) * (1.0 - smoothstep(280.0, 286.0, vW.y));
        extraEmissive += tc * trim * (0.3 + 0.7 * t);
        extraEmissive += vec3(0.8, 0.9, 1.0) * smoothstep(1046.0, 1054.0, vW.y) * 0.9;
      `
    },
    goal: {
      decl: '',
      code: `
        vec2 uv = wallUV();
        vec3 tc = vW.z < 0.0 ? vec3(0.01, 0.17, 1.0) : vec3(1.0, 0.17, 0.007);
        float hx = hexDist(uv / 42.0);
        float line = smoothstep(0.40, 0.5, hx);
        diffuseColor.rgb = mix(tc * 0.12, tc * 0.6 + 0.05, line);
        diffuseColor.a = mix(0.82, 1.0, line);
        extraEmissive += tc * (line * 0.55 + 0.05);
      `
    },
    frame: {
      decl: '',
      code: `
        vec3 tc = vW.z < 0.0 ? vec3(0.02, 0.21, 1.0) : vec3(1.0, 0.21, 0.013);
        diffuseColor.rgb = tc;
        extraEmissive += tc * (1.1 + 0.2 * sin(uTime * 2.5 + vW.y * 0.01));
      `
    },
    glass: {
      decl: 'uniform float uGlassOpacity;',
      code: `
        vec2 uv = wallUV();
        vec3 tc = teamColor();
        float hx = hexDist(uv / 150.0);
        float line = smoothstep(0.465, 0.5, hx);
        float fade = 1.0 - smoothstep(1300.0, 2100.0, vW.y) * 0.35;
        diffuseColor.rgb = tc;
        diffuseColor.a = uGlassOpacity + line * 0.4 * fade;
        extraEmissive += tc * line * 0.3 * fade;
      `
    }
  };

  function applyPattern(shader, key, uniforms) {
    const p = PATTERNS[key];
    shader.uniforms.uTime = TIME;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vW;\nvarying vec3 vN;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vN = normalize(mat3(modelMatrix) * objectNormal);'
    );
    shader.fragmentShader = GLSL_COMMON + p.decl + '\n' + shader.fragmentShader
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity );\n  vec3 extraEmissive = vec3(0.0);\n' + p.code)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += extraEmissive;');
  }

  function patternMaterial(key, params, uniforms) {
    const m = new THREE.MeshStandardMaterial(params);
    // three.js caches programs by the onBeforeCompile source, so give each pattern its own text
    m.onBeforeCompile = eval('(function (shader) { /* pattern:' + key + ' */ applyPattern(shader, "' + key + '", uniforms); })');
    m.customProgramCacheKey = () => 'pattern-' + key;
    return m;
  }

  // ---------------- geometry helpers ----------------
  function wallOutline(extraSub) {
    const X = G.extentX, Y = G.extentY, C = G.cornerPlane, rc = G.cornerRoundRadius;
    const verts = [[X, -(C - X)], [X, C - X], [C - Y, Y], [-(C - Y), Y], [-X, C - X], [-X, -(C - X)], [-(C - Y), -Y], [C - Y, -Y]];
    const n = verts.length;
    const norm2 = v => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
    const corners = verts.map((v, i) => {
      const p = verts[(i + n - 1) % n], q = verts[(i + 1) % n];
      const din = norm2([v[0] - p[0], v[1] - p[1]]), dout = norm2([q[0] - v[0], q[1] - v[1]]);
      const nin = [-din[1], din[0]], nout = [-dout[1], dout[0]];
      const k = rc / (1 + nin[0] * nout[0] + nin[1] * nout[1]);
      const c = [v[0] + (nin[0] + nout[0]) * k, v[1] + (nin[1] + nout[1]) * k];
      let a1 = Math.atan2(-nin[1], -nin[0]), a2 = Math.atan2(-nout[1], -nout[0]);
      while (a2 < a1) a2 += Math.PI * 2;
      return { c, a1, a2, nout };
    });
    const pts = [];
    const step = extraSub || 800;
    corners.forEach((cn, i) => {
      for (let s = 0; s <= 8; s++) {
        const a = cn.a1 + (cn.a2 - cn.a1) * s / 8;
        pts.push({ x: cn.c[0] + Math.cos(a) * rc, y: cn.c[1] + Math.sin(a) * rc, nx: -Math.cos(a), ny: -Math.sin(a) });
      }
      const next = corners[(i + 1) % n];
      const p0 = { x: cn.c[0] - cn.nout[0] * rc, y: cn.c[1] - cn.nout[1] * rc };
      const p1 = { x: next.c[0] - cn.nout[0] * rc, y: next.c[1] - cn.nout[1] * rc };
      const steps = Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y) / step);
      for (let s = 1; s < steps; s++) {
        pts.push({ x: p0.x + (p1.x - p0.x) * s / steps, y: p0.y + (p1.y - p0.y) * s / steps, nx: cn.nout[0], ny: cn.nout[1] });
      }
    });
    pts.push(Object.assign({}, pts[0]));
    let s = 0;
    pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.s = s; });
    return pts;
  }

  function sweep(outline, profile, opts) {
    opts = opts || {};
    const pos = [], uv = [], idx = [];
    const cols = profile.length;
    let acc = 0;
    const pv = profile.map((pr, i) => {
      if (i) acc += Math.hypot(pr.l - profile[i - 1].l, pr.z - profile[i - 1].z);
      return pr.v !== undefined ? pr.v : acc;
    });
    outline.forEach(p => {
      profile.forEach((pr, j) => {
        pos.push(p.x + p.nx * pr.l, pr.z, p.y + p.ny * pr.l);
        uv.push(p.s / (opts.uScale || 512), pv[j] / (opts.vScale || 512));
      });
    });
    for (let i = 0; i < outline.length - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j, b = (i + 1) * cols + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  }

  // Flip the whole index if its triangles face away from wantFn(centroid)
  function orient(geo, wantFn) {
    const p = geo.attributes.position, index = geo.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let votes = 0;
    for (let t = 0; t < index.length && Math.abs(votes) < 12; t += Math.max(3, Math.floor(index.length / 60 / 3) * 3)) {
      a.fromBufferAttribute(p, index[t]); b.fromBufferAttribute(p, index[t + 1]); c.fromBufferAttribute(p, index[t + 2]);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-6) continue;
      const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      votes += n.dot(wantFn(cen)) > 0 ? 1 : -1;
    }
    if (votes < 0) {
      const arr = index;
      for (let t = 0; t < arr.length; t += 3) { const tmp = arr[t + 1]; arr[t + 1] = arr[t + 2]; arr[t + 2] = tmp; }
      geo.index.needsUpdate = true;
    }
    geo.computeVertexNormals();
    return geo;
  }

  const sdfInward = cen => { const n = Game.Arena.normal(cen.x, cen.z, cen.y); return new THREE.Vector3(n.x, n.z, n.y); };
  const towardField = cen => new THREE.Vector3(-cen.x, 0, -cen.z).normalize().add(new THREE.Vector3(0, 0.4, 0));

  // ---------------- pitch ----------------
  function pitchTexture(T) {
    const W = 8192, L = 12000;
    return canvasTexture(2048, 3000, (ctx, w, h) => {
      const sx = w / W, sy = h / L;
      const P = (x, y) => [(x + W / 2) * sx, (y + L / 2) * sy];
      ctx.fillStyle = T.goalTurf; ctx.fillRect(0, 0, w, h);
      const stripes = 10, span = 2 * G.extentY / stripes;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = T.grass[i % 2];
        ctx.fillRect(0, P(0, -G.extentY + span * i)[1], w, span * sy + 1);
      }
      [-1, 1].forEach(s => {
        const y0 = P(0, s * 5120)[1], y1 = P(0, s * 2600)[1];
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        const c = s < 0 ? '31,123,255' : '255,122,26';
        g.addColorStop(0, `rgba(${c},0.22)`); g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, Math.min(y0, y1), w, Math.abs(y1 - y0));
      });

      ctx.lineCap = 'round';
      const line = (width, color) => { ctx.lineWidth = width * sx; ctx.strokeStyle = color; };
      line(36, T.line);
      ctx.beginPath(); ctx.moveTo(...P(-4096 + 256, 0)); ctx.lineTo(...P(4096 - 256, 0)); ctx.stroke();
      ctx.beginPath(); ctx.arc(...P(0, 0), 1100 * sx, 0, Math.PI * 2); ctx.stroke();
      line(20, T.line);
      ctx.beginPath(); ctx.arc(...P(0, 0), 1040 * sx, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = T.line;
      ctx.beginPath(); ctx.arc(...P(0, 0), 90 * sx, 0, Math.PI * 2); ctx.fill();

      // boundary following the wall base
      line(30, T.line);
      ctx.beginPath();
      [[4096 - 260, -3710], [4096 - 260, 3710], [2690, 5120 - 260], [-2690, 5120 - 260], [-4096 + 260, 3710], [-4096 + 260, -3710], [-2690, -5120 + 260], [2690, -5120 + 260]]
        .forEach((p, i) => (i ? ctx.lineTo(...P(p[0], p[1])) : ctx.moveTo(...P(p[0], p[1]))));
      ctx.closePath(); ctx.stroke();

      [-1, 1].forEach(s => {
        const teamLine = s < 0 ? 'rgba(150,200,255,0.95)' : 'rgba(255,200,150,0.95)';
        const box = (hx, depth, width, color) => {
          line(width, color);
          ctx.beginPath();
          ctx.moveTo(...P(-hx, s * (5120 - 260)));
          ctx.lineTo(...P(-hx, s * (5120 - depth)));
          ctx.lineTo(...P(hx, s * (5120 - depth)));
          ctx.lineTo(...P(hx, s * (5120 - 260)));
          ctx.stroke();
        };
        box(1250, 850, 30, T.line);
        box(2250, 1750, 30, teamLine);
        line(30, teamLine);
        ctx.beginPath(); ctx.arc(...P(0, s * (5120 - 1750)), 650 * sx, s < 0 ? 0 : Math.PI, s < 0 ? Math.PI : Math.PI * 2); ctx.stroke();
        ctx.fillStyle = T.line;
        ctx.beginPath(); ctx.arc(...P(0, s * (5120 - 1300)), 50 * sx, 0, Math.PI * 2); ctx.fill();
        line(40, teamLine);
        ctx.beginPath(); ctx.moveTo(...P(-G.goalHalfWidth, s * 5120)); ctx.lineTo(...P(G.goalHalfWidth, s * 5120)); ctx.stroke();
        // corner arcs
        [-1, 1].forEach(cx => {
          line(24, T.line);
          ctx.beginPath();
          ctx.arc(...P(cx * 2900, s * 4300), 380 * sx, 0, Math.PI * 2);
          ctx.stroke();
        });
      });
      // faint boost pad circles
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 14 * sx;
      Game.BoostPads.SMALL.forEach(p => { ctx.beginPath(); ctx.arc(...P(p[0], p[1]), 150 * sx, 0, Math.PI * 2); ctx.stroke(); });
      Game.BoostPads.BIG.forEach(p => { ctx.beginPath(); ctx.arc(...P(p[0], p[1]), 230 * sx, 0, Math.PI * 2); ctx.stroke(); });
    });
  }

  function floorMesh(T) {
    const X = G.extentX, Y = G.extentY, C = G.cornerPlane, gw = G.goalHalfWidth, gy = Y + G.goalDepth;
    const outline = [[X, -(C - X)], [X, C - X], [C - Y, Y], [gw, Y], [gw, gy], [-gw, gy], [-gw, Y], [-(C - Y), Y], [-X, C - X],
      [-X, -(C - X)], [-(C - Y), -Y], [-gw, -Y], [-gw, -gy], [gw, -gy], [gw, -Y], [C - Y, -Y]];
    const faces = THREE.ShapeUtils.triangulateShape(outline.map(p => new THREE.Vector2(p[0], p[1])), []);
    const pos = [], uv = [], idx = [];
    outline.forEach(p => { pos.push(p[0], 0, p[1]); uv.push((p[0] + 4096) / 8192, 1 - (p[1] + 6000) / 12000); });
    faces.forEach(f => idx.push(f[0], f[1], f[2]));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    orient(geo, () => new THREE.Vector3(0, 1, 0));
    const mesh = new THREE.Mesh(geo, patternMaterial('floor', { map: pitchTexture(T), roughness: 0.92, metalness: 0 }, { uGrain: { value: T.grain } }));
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---------------- arena shell ----------------
  function arenaShell(T) {
    const data = Game.ArenaMesh.get();
    const n = data.positions.length / 3;
    const P = data.positions, N = data.normals, I = data.index;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = P[i * 3]; pos[i * 3 + 1] = P[i * 3 + 2]; pos[i * 3 + 2] = P[i * 3 + 1];
      nor[i * 3] = N[i * 3]; nor[i * 3 + 1] = N[i * 3 + 2]; nor[i * 3 + 2] = N[i * 3 + 1];
    }
    // swapping y/z mirrors the mesh, so reverse the winding to keep faces pointing inward
    const idx = new Uint32Array(I.length);
    for (let t = 0; t < I.length; t += 3) { idx[t] = I[t]; idx[t + 1] = I[t + 2]; idx[t + 2] = I[t + 1]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    data.groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));

    const mats = [
      patternMaterial('turf', { color: 0xffffff, roughness: 0.95, metalness: 0 }, { uGrassA: { value: lin(T.grass[0]) }, uGrassB: { value: lin(T.grass[1]) }, uGrain: { value: T.grain } }),
      patternMaterial('lower', { color: 0xffffff, roughness: 0.55, metalness: 0.15 }, { uWallBase: { value: lin(T.wallBase) } }),
      patternMaterial('goal', { color: 0xffffff, roughness: 0.6, metalness: 0.1, transparent: true }),
      patternMaterial('frame', { color: 0xffffff, roughness: 0.25, metalness: 0.4, toneMapped: false })
    ];
    const mesh = new THREE.Mesh(geo, mats);
    mesh.receiveShadow = true;
    return mesh;
  }

  function glassShell(T) {
    const rt = G.ceilingRampRadius, top = Game.ArenaMesh.TOP_Z;
    const outline = wallOutline(600);
    const prof = [{ l: 0, z: top }, { l: 0, z: H - rt }];
    for (let i = 1; i <= 10; i++) { const f = (i / 10) * Math.PI / 2; prof.push({ l: rt - rt * Math.cos(f), z: H - rt + rt * Math.sin(f) }); }
    const wallGeo = orient(sweep(outline, prof), sdfInward);

    const ring = outline.slice(0, -1).map(p => new THREE.Vector2(p.x + p.nx * rt, p.y + p.ny * rt));
    const ceilGeo = new THREE.ShapeGeometry(new THREE.Shape(ring));
    ceilGeo.rotateX(Math.PI / 2);
    ceilGeo.translate(0, H, 0);
    orient(ceilGeo, () => new THREE.Vector3(0, -1, 0));

    const mat = patternMaterial('glass', { color: 0xffffff, roughness: 0.08, metalness: 0.3, transparent: true, depthWrite: false }, { uGlassOpacity: { value: T.glassOpacity } });
    const group = new THREE.Group();
    const wall = new THREE.Mesh(wallGeo, mat), ceil = new THREE.Mesh(ceilGeo, mat);
    wall.renderOrder = ceil.renderOrder = 2;
    group.add(wall, ceil);
    return group;
  }

  // ---------------- sky + environment ----------------
  function skyMaterial(T) {
    const sd = new THREE.Vector3(...T.sunDir).normalize();
    return new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: lin(T.sky[0]) }, mid: { value: lin(T.sky[1]) }, horizon: { value: lin(T.sky[2]) },
        sunDir: { value: sd }, sunColor: { value: lin(T.sunColor) }, clouds: { value: T.clouds }, stars: { value: T.stars || 0 }, uTime: TIME
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;
        uniform float clouds; uniform float stars; uniform float uTime; varying vec3 vDir;
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 c = mix(horizon, mid, smoothstep(-0.05, 0.28, y));
          c = mix(c, top, smoothstep(0.28, 1.0, y));
          float sd = max(dot(d, sunDir), 0.0);
          c += sunColor * (pow(sd, 600.0) * 6.0 + pow(sd, 12.0) * 0.35);
          if (y > 0.0) {
            vec2 uv = d.xz / (y + 0.12) * 1.4 + vec2(uTime * 0.004, 0.0);
            float n = fbm(uv);
            float cl = smoothstep(0.48, 0.82, n) * clouds * smoothstep(0.0, 0.2, y);
            vec3 cloudCol = mix(vec3(0.95), sunColor, 0.35) * (0.75 + 0.5 * sd);
            c = mix(c, cloudCol, cl * 0.85);
          }
          if (stars > 0.0 && y > 0.02) {
            vec2 sp = floor(d.xz / (y + 0.35) * 260.0);
            float st = step(0.9965, h21(sp)) * (0.6 + 0.4 * sin(uTime * 2.0 + h21(sp + 3.1) * 40.0));
            c += vec3(0.9, 0.95, 1.0) * st * stars * smoothstep(0.02, 0.25, y);
          }
          c = mix(c, horizon * 0.6, smoothstep(0.0, -0.3, y));
          gl_FragColor = vec4(c, 1.0);
        }`
    });
  }

  // Reflections for the car, ball and glossy surfaces (three.js studio environment)
  function environmentMap(renderer) {
    if (!THREE.RoomEnvironment) return null;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04);
    pmrem.dispose();
    return rt;
  }

  // ---------------- stadium scenery ----------------
  function crowdTexture(T) {
    return canvasTexture(1024, 512, (ctx, w, h) => {
      ctx.fillStyle = T.standBase; ctx.fillRect(0, 0, w, h);
      const skin = ['#f1c7a5', '#d9a47f', '#a86f4c', '#6b4530', '#f5d6bd'];
      const rowH = 32;
      for (let y = 0; y < h; y += rowH) {
        const g = ctx.createLinearGradient(0, y, 0, y + rowH);
        g.addColorStop(0, 'rgba(255,255,255,0.06)'); g.addColorStop(0.7, 'rgba(0,0,0,0.1)'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
        ctx.fillStyle = g; ctx.fillRect(0, y, w, rowH);
        for (let x = 3; x < w - 10; x += 13 + Math.random() * 3) {
          if (Math.random() < 0.1) continue;
          const lift = Math.random() < 0.15 ? -5 : 0;
          ctx.fillStyle = T.crowd[(Math.random() * T.crowd.length) | 0];
          ctx.fillRect(x, y + 13 + lift, 10, 15);
          ctx.fillStyle = skin[(Math.random() * skin.length) | 0];
          ctx.beginPath(); ctx.arc(x + 5, y + 9 + lift, 4.2, 0, Math.PI * 2); ctx.fill();
          if (lift) { ctx.fillRect(x - 2, y + 2 + lift, 2, 10); ctx.fillRect(x + 10, y + 2 + lift, 2, 10); }
        }
      }
    }, true);
  }

  function adTexture() {
    return canvasTexture(2048, 128, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#0a2a6b'); g.addColorStop(0.5, '#0b0e18'); g.addColorStop(1, '#6b2a0a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.textBaseline = 'middle';
      const words = ['CAR BALL', 'SUPERSONIC', 'FREE PLAY', 'ROCKETSIM PHYSICS'];
      for (let i = 0; i < 4; i++) {
        const x = i * 512;
        ctx.font = 'italic 900 64px Segoe UI, Arial, sans-serif';
        ctx.fillStyle = i % 2 ? '#ffb45c' : '#8fc8ff';
        ctx.fillText(words[i], x + 36, h / 2 + 3);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
    }, true);
  }

  function screenTexture() {
    return canvasTexture(1024, 512, () => {});
  }

  function drawScreen(tex, blue, orange) {
    const c = tex.canvas, ctx = c.getContext('2d'), w = c.width, h = c.height;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#0c46b8'); g.addColorStop(0.5, '#070a12'); g.addColorStop(1, '#b8520c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'italic 900 70px Segoe UI, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('CAR BALL', w / 2, 70);
    ctx.font = '900 250px Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#a9d0ff'; ctx.fillText(blue, w * 0.27, h * 0.62);
    ctx.fillStyle = '#ffc49a'; ctx.fillText(orange, w * 0.73, h * 0.62);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(w / 2 - 6, h * 0.45, 12, h * 0.34);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
    tex.needsUpdate = true;
  }

  function buildScenery(root, T, anims) {
    const outline = wallOutline(900);
    const structure = new THREE.MeshStandardMaterial({ color: col(T.structure), roughness: 0.7, metalness: 0.35 });
    const L0 = -1350;

    // ground around the arena
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), new THREE.MeshStandardMaterial({ color: col(T.ground || '#1b1f26'), roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -6;
    root.add(ground);

    // LED advertising boards at the foot of the stands
    const ads = adTexture();
    const adsMesh = new THREE.Mesh(orient(sweep(outline, [{ l: L0, z: 0, v: 0 }, { l: L0, z: 280, v: 512 }], { uScale: 3200 }), towardField),
      new THREE.MeshBasicMaterial({ map: ads, toneMapped: false }));
    root.add(adsMesh);
    anims.push(dt => { ads.offset.x = (ads.offset.x + dt * 0.015) % 1; });

    // stands: lower tier, concourse, upper tier, back wall
    const crowd = crowdTexture(T);
    const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 1, emissive: 0xffffff, emissiveMap: crowd, emissiveIntensity: 0.22 });
    const tier = profile => new THREE.Mesh(orient(sweep(outline, profile, { uScale: 2900, vScale: 1450 }), towardField), crowdMat);
    root.add(tier([{ l: L0, z: 280 }, { l: L0 - 80, z: 330 }, { l: -3500, z: 2050 }]));
    // Open-air maps keep only the lower tier, so the scenery beyond shows over the stands
    const closed = !T.open;
    if (closed) root.add(tier([{ l: -3750, z: 2400 }, { l: -6000, z: 4550 }]));
    const band = new THREE.Mesh(orient(sweep(outline, [{ l: -3500, z: 2050 }, { l: -3500, z: 2330 }, { l: -3750, z: 2400 }]), towardField), structure);
    root.add(band);
    const bandLights = new THREE.Mesh(orient(sweep(outline, [{ l: -3502, z: 2170 }, { l: -3502, z: 2210 }]), towardField),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.7, 2.0), toneMapped: false }));
    root.add(bandLights);
    if (closed) root.add(new THREE.Mesh(orient(sweep(outline, [{ l: -6000, z: 4550 }, { l: -6000, z: 5200 }]), towardField), structure));

    // roof ring with a lit inner edge
    if (closed) {
      const roofGeo = sweep(outline, [{ l: -6000, z: 5200 }, { l: -6100, z: 5700 }, { l: -1900, z: 6300 }, { l: -1900, z: 6050 }, { l: -6000, z: 5200 }]);
      roofGeo.computeVertexNormals();
      const roofMat = structure.clone();
      roofMat.side = THREE.DoubleSide;
      root.add(new THREE.Mesh(roofGeo, roofMat));
    }

    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.35, 2.2), toneMapped: false });
    const spacing = 520;
    const count = Math.floor(outline[outline.length - 1].s / spacing);
    const lights = new THREE.InstancedMesh(new THREE.BoxGeometry(300, 40, 140), lightMat, count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < count; k++) {
      const s = k * spacing;
      let j = outline.findIndex(p => p.s >= s);
      if (j <= 0) j = 1;
      const a = outline[j - 1], b = outline[j], f = (s - a.s) / Math.max(b.s - a.s, 1);
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      q.setFromAxisAngle(yAxis, -Math.atan2(a.ny, a.nx));
      m4.compose(new THREE.Vector3(x - a.nx * 2050, 6030, y - a.ny * 2050), q, new THREE.Vector3(1, 1, 1));
      lights.setMatrixAt(k, m4);
    }
    if (closed) root.add(lights);

    // corner floodlight towers
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(260, 7600, 260), structure);
      tower.position.set(sx * 8600, 3800, sz * 11600);
      root.add(tower);
      const bank = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2000, 900, 120), structure);
      bank.add(frame);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          const lamp = new THREE.Mesh(new THREE.PlaneGeometry(260, 200), lightMat);
          lamp.position.set(-825 + c * 330, -290 + r * 290, 62);
          bank.add(lamp);
        }
      }
      bank.position.set(sx * 8600, 7700, sz * 11600);
      bank.lookAt(0, 0, 0);
      root.add(bank);
    });

    // jumbotrons over each end and a hanging centre scoreboard
    const screens = [];
    [-1, 1].forEach(s => {
      const tex = screenTexture();
      screens.push(tex);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(3400, 1600, 120), structure));
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(3200, 1500), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      screen.position.z = 62;
      g.add(screen);
      g.position.set(0, 3500, s * 8150);
      g.rotation.y = s > 0 ? Math.PI : 0;
      root.add(g);
    });
    const cubeTex = screenTexture();
    screens.push(cubeTex);
    const cube = new THREE.Group();
    cube.add(new THREE.Mesh(new THREE.BoxGeometry(1500, 700, 1500), structure));
    for (let i = 0; i < 4; i++) {
      const sc = new THREE.Mesh(new THREE.PlaneGeometry(1400, 620), new THREE.MeshBasicMaterial({ map: cubeTex, toneMapped: false }));
      sc.rotation.y = i * Math.PI / 2;
      sc.position.set(Math.sin(i * Math.PI / 2) * 752, 0, Math.cos(i * Math.PI / 2) * 752);
      cube.add(sc);
    }
    const trim = new THREE.Mesh(new THREE.CylinderGeometry(1080, 1080, 40, 4, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.3, 2.2), toneMapped: false, side: THREE.DoubleSide }));
    trim.rotation.y = Math.PI / 4;
    trim.position.y = -370;
    cube.add(trim);
    cube.position.set(0, H + 1500, 0);
    root.add(cube);
    anims.push((dt, t) => { cube.rotation.y = Math.sin(t * 0.15) * 0.3; });

    return { setScore: (b, o) => screens.forEach(tex => drawScreen(tex, b, o)) };
  }

  // ---------------- boost pads ----------------
  function buildPads(root, pads) {
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x1d222b, roughness: 0.45, metalness: 0.7 });
    const smallGeo = new THREE.CylinderGeometry(92, 104, 10, 32);
    const bigGeo = new THREE.CylinderGeometry(170, 190, 16, 40);
    const ringGeo = new THREE.TorusGeometry(1, 0.1, 8, 40);
    const orbGeo = new THREE.SphereGeometry(52, 24, 16);
    const discGeo = new THREE.CircleGeometry(1, 32);
    return pads.map(p => {
      const g = new THREE.Group();
      g.position.set(p.pos.x * 50, 0, p.pos.y * 50);
      g.add(new THREE.Mesh(p.isBig ? bigGeo : smallGeo, baseMat));
      const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.2, 0.25), transparent: true, opacity: 1, toneMapped: false });
      const ring = new THREE.Mesh(ringGeo, glowMat);
      ring.rotation.x = Math.PI / 2;
      const rs = p.isBig ? 140 : 72;
      ring.scale.set(rs, rs, rs);
      ring.position.y = 11;
      g.add(ring);
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.55, 0.1), transparent: true, opacity: 0.5, toneMapped: false }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 11.5;
      const ds = p.isBig ? 110 : 44;
      disc.scale.set(ds, ds, ds);
      g.add(disc);
      let orb = null, halo = null;
      if (p.isBig) {
        orb = new THREE.Mesh(orbGeo, glowMat);
        orb.position.y = 115;
        g.add(orb);
        halo = new THREE.Mesh(ringGeo, glowMat);
        halo.scale.set(85, 85, 85);
        halo.position.y = 115;
        g.add(halo);
      }
      root.add(g);
      return { glowMat, disc, orb, halo, phase: Math.random() * 6 };
    });
  }

  // ---------------- build ----------------
  function build(scene, opts) {
    // A map's palette goes on top of the theme; its scenery is added after the stands
    const map = Game.Maps ? Game.Maps.get(opts.map) : null;
    const T = Object.assign({}, THEMES[opts.theme] || THEMES.realistic, map ? map.palette : {});
    const root = new THREE.Group();
    const scenery = new THREE.Group();
    const anims = [];
    scene.add(root);

    const skyMat = skyMaterial(T);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(100000, 48, 24), skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    root.add(sky);
    scene.background = col(T.fog);
    scene.fog = new THREE.Fog(col(T.fog), T.fogNear, T.fogFar);

    // Only the car and ball get these reflections; on the pitch they wash everything out
    const envRT = opts.renderer ? environmentMap(opts.renderer) : null;

    root.add(new THREE.HemisphereLight(col(T.hemi[0]), col(T.hemi[1]), T.hemi[2]));
    const sunDir = new THREE.Vector3(...T.sunDir).normalize();
    const sun = new THREE.DirectionalLight(col(T.sunColor), T.sunI);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -1600, right: 1600, top: 1600, bottom: -1600, near: 10, far: 12000 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 2;
    root.add(sun, sun.target);

    root.add(floorMesh(T));
    root.add(arenaShell(T));
    root.add(glassShell(T));
    const stadium = buildScenery(scenery, T, anims);
    if (map && map.extras) map.extras(scenery, T, anims);
    root.add(scenery);
    const padViews = buildPads(root, opts.boostPads);
    let time = 0;

    return {
      update(focus, dt, pads) {
        time += dt;
        TIME.value = time;
        sun.position.copy(focus).addScaledVector(sunDir, 6000);
        sun.target.position.copy(focus);
        anims.forEach(fn => fn(dt, time));
        padViews.forEach((v, i) => {
          const active = !pads || pads[i].isActive !== false;
          v.glowMat.opacity += ((active ? 1 : 0.15) - v.glowMat.opacity) * Math.min(dt * 6, 1);
          v.disc.material.opacity = active ? 0.45 + 0.15 * Math.sin(time * 4 + v.phase) : 0.08;
          if (v.orb) {
            v.orb.visible = v.halo.visible = active;
            const bob = Math.sin(time * 2 + v.phase) * 14;
            v.orb.position.y = v.halo.position.y = 115 + bob;
            v.halo.rotation.set(time * 1.3, time * 0.9, 0);
          }
        });
      },
      setShowStadium(show) {
        scenery.visible = show;
        sky.visible = show;
        scene.background = show ? col(T.fog) : new THREE.Color(0x0b0f17);
      },
      setScore: stadium.setScore,
      envMap: envRT ? envRT.texture : null,
      dispose() {
        scene.remove(root);
        if (envRT) envRT.dispose();
        root.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) [].concat(o.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
        });
      }
    };
  }

  return { build, THEMES };
})();
