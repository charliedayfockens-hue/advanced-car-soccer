// Car and ball visuals. Cars come from the garage models (assets/cars), fitted to the simulated Octane
// hitbox; a boxy hot-hatch built from primitives stands in until a model has loaded (or if it fails).
// Wheels follow the simulated suspension length, steering angle and ground speed.
// Local car frame in three.js: +X forward, +Y up, +Z right (RL local x, z, y). Car origin sits
// 17uu above the ground at rest.
window.Game = window.Game || {};

Game.View = (function () {
  const BT = Game.RL.BT_TO_UU;

  function toThreePos(p, out) { return (out || new THREE.Vector3()).set(p.x * BT, p.z * BT, p.y * BT); }

  const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  function toThreeQuat(rot, out) {
    const f = rot.col(0), r = rot.col(1), u = rot.col(2);
    _x.set(f.x, f.z, f.y); _y.set(u.x, u.z, u.y); _z.set(r.x, r.z, r.y);
    _m.makeBasis(_x, _y, _z);
    return (out || new THREE.Quaternion()).setFromRotationMatrix(_m);
  }

  // Side profile (x forward, y up) extruded across the car's width, with rounded edges
  function profileMesh(points, width, bevel, mat) {
    const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p[0], p[1])));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 8 });
    geo.translate(0, 0, -(width - bevel * 2) / 2);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  // Box with rounded vertical-profile edges (extruded rounded rectangle)
  function roundBox(lx, ly, lz, r, mat) {
    const s = new THREE.Shape();
    const x = -lx / 2, y = -ly / 2;
    r = Math.min(r, lx / 2, ly / 2);
    s.moveTo(x + r, y);
    s.lineTo(x + lx - r, y); s.quadraticCurveTo(x + lx, y, x + lx, y + r);
    s.lineTo(x + lx, y + ly - r); s.quadraticCurveTo(x + lx, y + ly, x + lx - r, y + ly);
    s.lineTo(x + r, y + ly); s.quadraticCurveTo(x, y + ly, x, y + ly - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    const b = Math.min(r * 0.6, lz / 2 - 0.01);
    const geo = new THREE.ExtrudeGeometry(s, { depth: lz - b * 2, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 5 });
    geo.translate(0, 0, -(lz - b * 2) / 2);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  // ---------------- garage cars and the ball model ----------------
  const CARS = [
    { id: 'surbabu', name: 'Surbabu', type: 'fbx', url: 'assets/cars/surbabu/surbabu.fbx', desc: 'Turbo rally sedan with a tall rear wing.' },
    { id: 'nixxan', name: 'Nixxan Silaiva', type: 'obj', url: 'assets/cars/nixxan/nixxan.obj', desc: 'Light 90s drift coupe with pop-up attitude.' }
  ];

  const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  const models = { ready: false, cars: {}, ball: null, listeners: [] };

  function onModels(fn) { if (models.ready) fn(models); else models.listeners.push(fn); }

  function loadModels() {
    if (models.loading) return;
    models.loading = true;
    // Model files point at textures on their authors' disks; we assign ours afterwards
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => (/\.(png|jpe?g|tga|dds)$/i.test(url) ? BLANK_PNG : url));
    const tex = (url, srgb) => {
      const t = Game.Assets.texture(url);
      if (srgb) t.encoding = THREE.sRGBEncoding;
      t.anisotropy = 8;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    };
    const base = url => url.slice(0, url.lastIndexOf('/') + 1);
    // Downloads are checked by Game.Assets so a broken deploy is reported instead of silently skipped
    const loadFbx = url => (THREE.FBXLoader ? Game.Assets.fetchChecked(url, { kind: 'FBX', check: Game.Assets.isFbx })
      .then(buf => new THREE.FBXLoader(manager).parse(buf, base(url)))
      .catch(err => { Game.Assets.report(err, url); return null; }) : Promise.resolve(null));
    const loadObj = url => (THREE.OBJLoader ? Game.Assets.fetchChecked(url, { kind: 'OBJ', check: Game.Assets.isObj })
      // Drop stray line elements: OBJLoader turns any object containing a line into line segments, losing its faces
      .then(buf => new THREE.OBJLoader(manager).parse(new TextDecoder().decode(buf).replace(/^l\s.*$/gm, '')))
      .catch(err => { Game.Assets.report(err, url); return null; }) : Promise.resolve(null));

    const jobs = CARS.map(car => (car.type === 'fbx' ? loadFbx(car.url) : loadObj(car.url)).then(obj => {
      try { if (obj) models.cars[car.id] = PREPARE[car.id](obj, tex); } catch (e) { console.warn(car.name + ' model setup failed', e); }
    }));
    jobs.push(loadFbx('assets/ball/Ball.fbx').then(ball => {
      try { if (ball) models.ball = prepareBall(ball, tex); } catch (e) { console.warn('Ball model setup failed', e); }
    }));
    Promise.all(jobs).then(() => {
      models.ready = true;
      models.listeners.splice(0).forEach(fn => fn(models));
    });
  }

  // Materials the car view swaps for its own team paint
  const role = r => { const m = new THREE.MeshStandardMaterial(); m.userData.role = r; return m; };

  // Model space: metres, +Z forward, +X left, +Y up, ground at y = 0.
  // Wheels are scaled uniformly so the tires match the simulated wheel radius, which also puts the roof at
  // the hitbox top; the body is stretched to the Octane hitbox's length and width so both cars share it.
  const FIT = { length: 126, width: 84, hitboxCenterX: 13.88, groundY: -17, wheelRadius: 13.75 };
  const wheelIndexOf = c => (c.z > 0 ? 0 : 2) + (c.x > 0 ? 1 : 0); // sim wheels: 0 FR, 1 FL, 2 BR, 3 BL

  // parts: [{ geometry (model space), material, wheel: null | { tire, spins } }]
  function buildCar(parts) {
    const box = new THREE.Box3();
    parts.forEach(p => { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); p.center = p.geometry.boundingBox.getCenter(new THREE.Vector3()); });
    const tires = parts.filter(p => p.wheel && p.wheel.tire);
    const tb = tires[0].geometry.boundingBox;
    const sL = FIT.length / (box.max.z - box.min.z), sW = FIT.width / (box.max.x - box.min.x);
    const sH = FIT.wheelRadius / ((tb.max.y - tb.min.y) / 2);
    const cz = (box.min.z + box.max.z) / 2;
    // model (x, y, z) -> car (z * sL, y * sH, -x * sW), centred on the hitbox and standing on the ground
    const bodyM = new THREE.Matrix4().set(
      0, 0, sL, FIT.hitboxCenterX - cz * sL,
      0, sH, 0, FIT.groundY - box.min.y * sH,
      -sW, 0, 0, 0,
      0, 0, 0, 1);
    const wheelM = new THREE.Matrix4().set(0, 0, sH, 0, 0, sH, 0, 0, -sH, 0, 0, 0, 0, 0, 0, 1);
    const out = { body: [], wheels: [[], [], [], []], anchors: [], radius: FIT.wheelRadius };
    const centres = [];
    tires.forEach(p => { centres[wheelIndexOf(p.center)] = p.center; });
    parts.forEach(p => {
      if (!p.wheel) { out.body.push({ geometry: p.geometry.applyMatrix4(bodyM), material: p.material }); return; }
      const i = wheelIndexOf(p.center), c = centres[i];
      if (!c) return;
      out.wheels[i].push({ geometry: p.geometry.translate(-c.x, -c.y, -c.z).applyMatrix4(wheelM), material: p.material, spins: p.wheel.spins });
    });
    centres.forEach((c, i) => { out.anchors[i] = c.clone().applyMatrix4(bodyM); });
    return out;
  }

  function meshParts(obj, pick, wheelOf, skip) {
    const parts = [];
    obj.updateMatrixWorld(true);
    obj.traverse(o => {
      if (!o.isMesh || !o.geometry.attributes.position || !o.geometry.attributes.position.count) return;
      if (skip && skip(o)) return;
      const src = [].concat(o.material);
      const mats = src.map(m => pick(m.name || '', o.name));
      const names = src.map(m => m.name || '').join(' ');
      parts.push({ geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), material: mats.length === 1 ? mats[0] : mats, wheel: wheelOf(o, names) });
    });
    return parts;
  }

  // Surbabu (FBX): wheels are Tire / Rim / BrakeDisc / Calliper meshes per corner
  function prepareSurbabu(obj, tex) {
    const T = (n, srgb) => tex('assets/cars/surbabu/' + n, srgb);
    const S = 'Subaru_WRXSTITNR_2018_';
    const std = o => new THREE.MeshStandardMaterial(o);
    const grille = n => std({ map: T(S + n + '_DiffuseAOSO.png', true), normalMap: T(S + n + '_Normal.png'), roughness: 0.6, alphaTest: 0.5, side: THREE.DoubleSide });
    const M = {
      disc: std({ map: T('BrakeDisc_ForgedDrilled_DiffuseAOSO.png', true), normalMap: T('BrakeDisc_ForgedDrilled_Normal.png'), metalness: 0.8, roughness: 0.45 }),
      rim: std({ map: T('TNR_Rim89A_DiffuseAOSO.png', true), normalMap: T('TNR_Rim89A_Normal.png'), metalness: 0.85, roughness: 0.3 }),
      tire: std({ map: T('TOYO_ProxesR888_A_DiffuseAOSO.png', true), normalMap: T('TOYO_ProxesR888_A_Normal.png'), roughness: 0.92 }),
      calliper: std({ color: 0xc8102e, metalness: 0.35, roughness: 0.35 }),
      interior: std({ map: T('InteriorA_DiffuseAOSO.png', true), normalMap: T(S + 'InteriorA_Normal.png'), roughness: 0.85, alphaTest: 0.5 }),
      tilling: std({ map: T(S + 'InteriorTillingA_DiffuseAOSO.png', true), normalMap: T(S + 'InteriorTillingA_Normal.png'), roughness: 0.85 }),
      badge: std({ map: T('BadgeA_DiffuseAOSO.png', true), normalMap: T(S + 'BadgeA_Normal.png'), metalness: 0.7, roughness: 0.3, alphaTest: 0.5 }),
      base: std({ color: 0x0d0e10, roughness: 0.95 }),
      carbon: std({ map: T('common_carbon05_black_diff.png', true), normalMap: T('common_carbon05_norm.png'), metalness: 0.2, roughness: 0.35 }),
      coloured: std({ map: T('Global_Texture_Coloured_Diffuse.png', true), roughness: 0.6 }),
      grille1: std({ map: T('Grille1A_DiffuseAOSO.png', true), normalMap: T(S + 'Grille1A_Normal.png'), roughness: 0.6, alphaTest: 0.5, side: THREE.DoubleSide }),
      grille2: grille('Grille2A'), grille4: grille('Grille4A'), grille8: grille('Grille8A'), grille9: grille('Grille9A'), hoodGrille: grille('Hood0a_Grille1'),
      light: std({ map: T('LightA_Diffuse.png', true), emissiveMap: T(S + 'LightA_Emissive.png', true), emissive: 0xffffff, emissiveIntensity: 1.2, metalness: 0.4, roughness: 0.2 }),
      plate: std({ map: T(S + 'ManufacturerPlateA_Diffuse.png', true), roughness: 0.5 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0f18, roughness: 0.05, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.75 }),
      lightGlass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false }),
      tailGlass: std({ color: 0xff1a2a, emissive: 0xff0018, emissiveIntensity: 0.8, transparent: true, opacity: 0.85 }),
      amberGlass: std({ color: 0xff8a1a, emissive: 0xff6a00, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }),
      trim: std({ color: 0x0b0c0e, roughness: 0.5 })
    };
    const primary = role('primary'), accent = role('accent');
    const pick = (n, mesh) => {
      if (/BrakeDisc/.test(n)) return M.disc;
      if (/TNR_Rim/.test(n)) return M.rim;
      if (/TireBlur/.test(n)) return M.tire;
      if (/Calliper|phong1/.test(n)) return M.calliper;
      if (/InteriorTilling/.test(n)) return M.tilling;
      if (/InteriorA/.test(n)) return M.interior;
      if (/BadgeA/.test(n)) return M.badge;
      if (/Base_Material/.test(n)) return M.base;
      if (/Carbon/.test(n)) return M.carbon;
      if (/Coloured/.test(n)) return M.coloured;
      if (/Hood0a_Grille1/.test(n)) return M.hoodGrille;
      if (/Grille1A/.test(n)) return M.grille1;
      if (/Grille2A/.test(n)) return M.grille2;
      if (/Grille4A/.test(n)) return M.grille4;
      if (/Grille8A/.test(n)) return M.grille8;
      if (/Grille9A/.test(n)) return M.grille9;
      if (/LightA/.test(n)) return M.light;
      if (/ManufacturerPlate/.test(n)) return M.plate;
      if (/PaintTNR/.test(n)) return /Wing0a/.test(mesh) ? accent : primary;
      if (/red_glass/.test(n)) return M.tailGlass;
      if (/orange_glass/.test(n)) return M.amberGlass;
      if (/glass_light/.test(n)) return M.lightGlass;
      if (/glass_surr/.test(n)) return M.trim;
      if (/Window/.test(n)) return M.glass;
      return M.trim;
    };
    const wheelOf = (o, names) => (/TireBlur|TNR_Rim|BrakeDisc|Calliper|phong1/.test(names)
      ? { tire: /TireBlur/.test(names), spins: !/Calliper|phong1/.test(names) } : null);
    // The engine sits under a closed hood; skip its 32k triangles
    return buildCar(meshParts(obj, pick, wheelOf, o => /Engine_Geo/.test(o.name)));
  }

  // Nixxan Silaiva (OBJ, no .mtl): materials are matched by their usemtl names
  function prepareNixxan(obj, tex) {
    const T = (n, srgb) => tex('assets/cars/nixxan/' + n, srgb);
    const std = o => new THREE.MeshStandardMaterial(o);
    const M = {
      plastic: std({ color: 0x15171a, roughness: 0.7 }),
      rubber: std({ color: 0x0a0a0b, roughness: 0.95 }),
      mirror: std({ color: 0xdfe5ec, metalness: 1, roughness: 0.05 }),
      chrome: std({ color: 0xd8dde4, metalness: 1, roughness: 0.15 }),
      interior: std({ color: 0x1b1c1f, roughness: 0.85 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0f18, roughness: 0.05, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.75 }),
      gloss: new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.15, clearcoat: 1 }),
      blinker: std({ color: 0xff8a1a, emissive: 0xff6a00, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }),
      plate: std({ map: T('jpnumberplate_albedo.png', true), bumpMap: T('jpnumberplate_bump.png'), bumpScale: 0.02, roughness: 0.6 }),
      plateBack: std({ color: 0xeeeeee, roughness: 0.6 }),
      headlight: std({ map: T('Eb4Pd47HYQI.jpeg', true), normalMap: T('light1.png'), emissiveMap: T('Eb4Pd47HYQI.jpeg', true), emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.2 }),
      logo: std({ map: T('9ydP3AMbsBk.jpeg', true), roughness: 0.4, metalness: 0.3 }),
      disc: std({ color: 0x777b80, metalness: 0.8, roughness: 0.4 }),
      tire: std({ color: 0x111113, normalMap: T('NORMAL.png'), roughness: 0.92 }),
      rim: std({ color: 0xc9ced6, metalness: 0.9, roughness: 0.25 })
    };
    const primary = role('primary'), accent = role('accent');
    const byName = {
      body_paint: primary, body_paint2: accent,
      body_plastic: M.plastic, wipper_plastic: M.plastic, headlight_pl: M.plastic, 'Material.004': M.plastic,
      body_rubber: M.rubber, wipper_rubber: M.rubber, body_mirror: M.mirror,
      body_chrome: M.chrome, headlight_chrome: M.chrome, exh_chrome: M.chrome, logo_chrome: M.chrome, wheel_bolt_FL: M.chrome,
      body_focus: M.interior, 'focus_int.': M.interior, wheel_focus_FL: M.interior,
      body_win: M.glass, body_win_frame: M.gloss, body_pianoblack: M.gloss, blinker_glass: M.blinker,
      'number_tex,': M.plate, number_pl: M.plateBack, headlight_front_glass_tex: M.headlight, 'logo_panel.005': M.logo,
      brake_disc: M.disc, brake_disc1: M.disc, wheel_tire_FL: M.tire, wheel_rims_FL: M.rim
    };
    const pick = n => byName[n] || M.plastic;
    const wheelOf = o => (/^wheel_/.test(o.name) ? { tire: true, spins: true } : null);
    return buildCar(meshParts(obj, pick, wheelOf));
  }

  const PREPARE = { surbabu: prepareSurbabu, nixxan: prepareNixxan };

  function prepareBall(obj, tex) {
    const B = n => 'assets/ball/' + n;
    let main = null;
    const lights = [];
    obj.updateMatrixWorld(true);
    obj.traverse(o => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      if (/light/i.test(o.name)) lights.push(geo); else main = geo;
    });
    if (!main) return null;
    // centre and radius from the vertices (the bounding box isn't symmetric)
    const p = main.attributes.position;
    const c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) c.add(v.fromBufferAttribute(p, i));
    c.multiplyScalar(1 / p.count);
    let r = 0;
    for (let i = 0; i < p.count; i++) r += v.fromBufferAttribute(p, i).distanceTo(c);
    r /= p.count;
    const material = new THREE.MeshStandardMaterial({
      map: tex(B('Ball_D_Blue.png'), true), metalnessMap: tex(B('Ball_Mat_Metalness.png')), metalness: 1,
      roughness: 0.42, emissiveMap: tex(B('Ball_Mat_E.png'), true), emissive: 0xbfe4ff, emissiveIntensity: 0.9
    });
    const lightMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.0, 2.4), toneMapped: false });
    return { main, lights, center: c, radius: r, material, lightMaterial };
  }

  function stripeTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    g.addColorStop(0, '#ff2fb3'); g.addColorStop(1, '#ff9d2a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 64);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'italic 900 40px Segoe UI, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('HATCH·R', 300, 34);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  class CarView {
    constructor(scene, sim, color, accentColor, carId) {
      this.sim = sim;
      this.carId = carId || CARS[0].id;
      this.accentColor = accentColor === undefined ? 0xff2fb3 : accentColor;
      this.group = new THREE.Group();
      this.body = new THREE.Group();
      this.group.add(this.body);
      this.wheelSpin = [0, 0, 0, 0];
      this.baseColor = color;
      this.anchors = null;

      // hex colours are sRGB; the renderer works in linear space
      const srgb = hex => new THREE.Color(hex).convertSRGBToLinear();
      const paint = new THREE.MeshPhysicalMaterial({ color: srgb(color), roughness: 0.45, metalness: 0.1, clearcoat: 0.45, clearcoatRoughness: 0.2, envMapIntensity: 0.3 });
      const roof = new THREE.MeshPhysicalMaterial({ color: srgb(this.accentColor), roughness: 0.4, metalness: 0.15, clearcoat: 0.45, clearcoatRoughness: 0.2, envMapIntensity: 0.3 });
      const trim = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.55, metalness: 0.3 });
      const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0f18, roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 });
      const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.15, metalness: 1 });
      const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff4ff, emissiveIntensity: 2.2 });
      const tail = new THREE.MeshStandardMaterial({ color: 0xff2140, emissive: 0xff1030, emissiveIntensity: 1.6 });
      this.paint = paint;
      this.roofMat = roof;

      const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); this.body.add(mesh); return mesh; };

      // ---- lower body: sills between the wheels, arches built separately so wheels stay visible
      add(roundBox(46, 12, 80, 4, paint), 8, 4, 0);                      // centre sill section
      add(profileMesh([[64, -3], [79, -2], [81, 8], [79, 15], [64, 15]], 84, 3, paint), 0, 0, 0);    // front bumper block
      add(profileMesh([[-47, -2], [-56, -1], [-57, 12], [-52, 16], [-47, 16]], 82, 3, paint), 0, 0, 0); // rear bumper block

      // ---- upper body (boxy hatchback silhouette) above the wheel arches
      const shell = profileMesh([
        [-54, 12], [79, 12], [80, 18], [74, 21], [42, 23], [33, 24], [-52, 26], [-56, 20]
      ], 84, 3.5, paint);
      add(shell, 0, 0, 0);

      // ---- wheel arches: flared, squared-off fenders
      sim.wheels.forEach(w => {
        const r = w.radius * BT;
        const cx = w.connectionCS.x * BT, cz = Math.sign(w.connectionCS.y) * 38;
        const arch = new THREE.Shape();
        const R = r + 5.5, flat = 6;
        arch.moveTo(-R - flat, 0);
        arch.lineTo(-R - flat, 5);
        arch.absarc(0, 5, R, Math.PI, 0, true);
        arch.lineTo(R + flat, 5);
        arch.lineTo(R + flat, 0);
        arch.lineTo(R + flat + 2, 0);
        arch.lineTo(R + flat + 2, 14);
        arch.lineTo(-R - flat - 2, 14);
        arch.lineTo(-R - flat - 2, 0);
        const g = new THREE.ExtrudeGeometry(arch, { depth: 9, bevelEnabled: true, bevelThickness: 1.5, bevelSize: 1.5, bevelSegments: 2, curveSegments: 14 });
        g.translate(0, 0, -4.5);
        const m = new THREE.Mesh(g, paint);
        m.castShadow = true;
        m.position.set(cx, w.connectionCS.z * BT - 12 - 3, cz);
        this.body.add(m);
        // dark inner liner so the arch reads as an opening
        const liner = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.5, R - 0.5, 20, 18, 1, true, -Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ color: 0x07080a, side: THREE.BackSide, roughness: 1 }));
        liner.rotation.x = Math.PI / 2;
        liner.position.set(cx, w.connectionCS.z * BT - 10, cz * 0.72);
        this.body.add(liner);
      });

      // ---- cabin: glass greenhouse, painted pillars and a contrasting roof
      add(profileMesh([[33, 24], [12, 39], [-38, 41], [-51, 27]], 70, 2.5, glass), 0, 0, 0);
      add(profileMesh([[35, 23.5], [31, 23.5], [10, 38.5], [14, 38.5]], 73, 1.2, paint), 0, 0, 0);          // A pillars
      add(profileMesh([[-40, 40.5], [-35, 40.5], [-49, 27], [-53, 27]], 73, 1.2, paint), 0, 0, 0);         // C pillars
      add(roundBox(5, 15, 72.5, 1, paint), -9, 32, 0);                                                     // B pillars
      const roofPanel = add(roundBox(54, 3.2, 74, 1.6, roof), -13, 41.3, 0);
      roofPanel.rotation.z = -0.04;
      // roof spoiler
      add(profileMesh([[-36, 40], [-50, 41.5], [-55, 38.5], [-40, 38]], 74, 1.5, roof), 0, 1.5, 0);
      [-1, 1].forEach(s => add(roundBox(2, 5, 2, 0.8, trim), -50, 37, s * 30));

      // ---- hood bulge and vents
      add(profileMesh([[70, 21], [36, 24.5], [36, 26.5], [60, 24]], 30, 1.5, paint), 0, 0, 0);
      [-1, 1].forEach(s => add(roundBox(10, 1.2, 6, 0.5, trim), 52, 23.8, s * 26));

      // ---- front fascia: grille, round headlights, fog lamps, splitter
      add(roundBox(3, 9, 54, 2, trim), 80.5, 7, 0);
      for (let i = 0; i < 3; i++) add(roundBox(0.8, 0.8, 50, 0.3, chrome), 82, 4 + i * 3, 0);
      [-1, 1].forEach(s => {
        const bezel = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 3, 24), chrome);
        bezel.rotation.z = Math.PI / 2;
        add(bezel, 80.5, 10, s * 31);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 3.4, 24), lamp);
        lens.rotation.z = Math.PI / 2;
        add(lens, 81, 10, s * 31);
        const fog = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 2, 14), lamp);
        fog.rotation.z = Math.PI / 2;
        add(fog, 81.5, 0.5, s * 22);
      });
      add(roundBox(10, 2, 88, 1, trim), 78, -3.5, 0);

      // ---- rear: tail light bar, diffuser, exhausts, plate
      [-1, 1].forEach(s => add(roundBox(1.5, 4, 18, 1, tail), -57.2, 13, s * 29));
      add(roundBox(1.2, 1.5, 36, 0.6, tail), -57.3, 13.8, 0);
      add(roundBox(8, 5, 70, 2, trim), -55, -1, 0);
      add(roundBox(1, 7, 20, 0.5, new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.6 })), -57.8, 5.5, 0);
      [-1, 1].forEach(s => {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.9, 8, 14, 1, true), chrome);
        pipe.rotation.z = Math.PI / 2;
        add(pipe, -58, 0, s * 15);
      });

      // ---- side details: mirrors, door line, livery stripe
      [-1, 1].forEach(s => {
        add(roundBox(7, 4, 6, 1.5, roof), 22, 26, s * 40);
        add(roundBox(20, 0.6, 0.6, 0.2, trim), 6, 18, s * 42.2);
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(92, 5), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide }));
        stripe.rotation.y = s > 0 ? 0 : Math.PI;
        add(stripe, 8, 15, s * 42.35);
      });

      // ---- wheels
      const tireMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.92 });
      const rimMat = new THREE.MeshStandardMaterial({ color: 0x25272d, roughness: 0.35, metalness: 0.85 });
      const hubMat = new THREE.MeshStandardMaterial({ color: 0xff2fb3, roughness: 0.3, metalness: 0.6 });
      this.wheels = sim.wheels.map(w => {
        const r = w.radius * BT;
        const width = w.front ? 12 : 14;
        const pivot = new THREE.Group();
        const spin = new THREE.Group();
        const tire = new THREE.Mesh(new THREE.TorusGeometry(r - 3.2, 3.8, 10, 26), tireMat);
        tire.scale.set(1, 1, width / 7.6);
        const tread = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.2, r - 0.2, width - 2, 26, 1, true), tireMat);
        tread.rotation.x = Math.PI / 2;
        const outer = Math.sign(w.connectionCS.y);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 3, 20), rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.z = outer * (width / 2 - 2);
        spin.add(tire, tread, rim);
        for (let k = 0; k < 6; k++) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 1.15, 2.2, 1.6), rimMat);
          spoke.rotation.z = k * Math.PI / 6;
          spoke.position.z = outer * (width / 2 - 0.5);
          spin.add(spoke);
        }
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 2, 12), hubMat);
        hub.rotation.x = Math.PI / 2;
        hub.position.z = outer * (width / 2 + 0.3);
        spin.add(hub);
        spin.traverse(o => { if (o.isMesh) o.castShadow = true; });
        pivot.add(spin);
        this.group.add(pivot);
        return { pivot, spin, radius: r };
      });

      // ---- boost flames from the exhausts
      const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.flames = [-1, 1].map(s => {
        const g = new THREE.Group();
        const outerFlame = new THREE.Mesh(new THREE.ConeGeometry(6.5, 58, 14, 1, true), flameMat);
        outerFlame.rotation.z = Math.PI / 2;
        outerFlame.position.x = -29;
        const inner = new THREE.Mesh(new THREE.ConeGeometry(3.5, 32, 12, 1, true), coreMat);
        inner.rotation.z = Math.PI / 2;
        inner.position.x = -16;
        g.add(outerFlame, inner);
        g.position.set(-61, 0, s * 15);
        g.visible = false;
        this.group.add(g);
        return g;
      });
      this.boostLight = new THREE.PointLight(0xff9a3a, 0, 420, 2);
      this.boostLight.position.set(-85, 8, 0);
      this.group.add(this.boostLight);

      // Collision hitbox (Training > Show Car Hitbox)
      const hs = sim.hitboxHalf, ho = sim.hitboxOffset;
      this.hitbox = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(hs.x * 2 * BT, hs.z * 2 * BT, hs.y * 2 * BT)),
        new THREE.LineBasicMaterial({ color: 0x7dff9a, depthTest: false, transparent: true, opacity: 0.9 })
      );
      this.hitbox.position.set(ho.x * BT, ho.z * BT, ho.y * BT);
      this.hitbox.renderOrder = 10;
      this.hitbox.visible = false;
      this.group.add(this.hitbox);

      scene.add(this.group);
      this.scene = scene;
      onModels(m => this.useModel(m));
    }

    // Swap the built-in body and wheels for this car's garage model
    useModel(m) {
      const car = m.cars && m.cars[this.carId];
      if (!car || this.disposed) return;
      const swap = mat => (mat.userData.role === 'primary' ? this.paint : mat.userData.role === 'accent' ? this.roofMat : mat);
      const mats = mat => (Array.isArray(mat) ? mat.map(swap) : swap(mat));
      const body = new THREE.Group();
      car.body.forEach(p => {
        const mesh = new THREE.Mesh(p.geometry, mats(p.material));
        mesh.castShadow = true;
        body.add(mesh);
      });
      this.group.add(body);
      this.body.visible = false;
      this.modelBody = body;
      this.anchors = car.anchors;
      car.wheels.forEach((parts, i) => {
        const v = this.wheels[i];
        if (!v || !parts.length) return;
        v.spin.children.forEach(c => { c.visible = false; });
        parts.forEach(p => {
          const mesh = new THREE.Mesh(p.geometry, mats(p.material));
          mesh.castShadow = true;
          (p.spins ? v.spin : v.pivot).add(mesh);
        });
        v.radius = car.radius;
      });
    }

    // 'alpha' gives gold exhaust flames; 'standard' the orange ones
    setBoostStyle(style) {
      this.boostStyle = style;
      const alpha = style === 'alpha';
      this.flames.forEach(g => {
        g.children[0].material.color.set(alpha ? 0xffc23a : 0xff9a3a);
        g.children[1].material.color.set(alpha ? 0xfffbe6 : 0xfff1c8);
      });
      this.boostLight.color.set(alpha ? 0xffcf5a : 0xff9a3a);
    }

    setPaint(primary, accent) {
      const srgb = hex => new THREE.Color(hex).convertSRGBToLinear();
      this.paint.color.copy(srgb(primary));
      this.roofMat.color.copy(srgb(accent));
    }

    dispose() {
      this.disposed = true;
      if (this.scene) this.scene.remove(this.group);
    }

    static liveData(sim) {
      return {
        fwdSpeed: sim.body.linVel.dot(sim.body.rot.col(0)) * BT,
        boosting: sim.state.isBoosting,
        supersonic: sim.state.isSupersonic,
        wheels: sim.wheels.map(w => [w.suspensionLength, w.steerAngle])
      };
    }

    setShowHitbox(show) { this.hitbox.visible = show; }

    setTheme(theme) {
      const arcade = theme === 'arcade';
      [this.paint, this.roofMat].forEach(m => {
        m.roughness = arcade ? 0.7 : 0.45;
        m.metalness = arcade ? 0.0 : 0.1;
        m.clearcoat = arcade ? 0 : 0.45;
        m.needsUpdate = true;
      });
    }

    update(position, quaternion, dt, d) {
      const sim = this.sim;
      this.group.position.copy(position);
      this.group.quaternion.copy(quaternion);

      sim.wheels.forEach((w, i) => {
        const v = this.wheels[i];
        const c = w.connectionCS, a = this.anchors && this.anchors[i];
        // Model wheels stay where the model puts them and move with the simulated suspension
        if (a) v.pivot.position.set(a.x, a.y + (w.restLength - d.wheels[i][0]) * BT, a.z);
        else v.pivot.position.set(c.x * BT, (c.z - d.wheels[i][0]) * BT, c.y * BT);
        v.pivot.rotation.y = -d.wheels[i][1];
        this.wheelSpin[i] -= (d.fwdSpeed / v.radius) * dt;
        v.spin.rotation.z = this.wheelSpin[i];
      });

      this.flames.forEach(f => {
        f.visible = d.boosting;
        if (d.boosting) {
          const k = 0.8 + Math.random() * 0.45 + (d.supersonic ? 0.35 : 0);
          f.scale.set(k, 0.9 + Math.random() * 0.2, 0.9 + Math.random() * 0.2);
        }
      });
      this.boostLight.intensity = d.boosting ? 2.2 + Math.random() * 0.6 : 0;
    }
  }

  // Garage preview: renders one car into an image with the main renderer
  function renderThumbnail(renderer, carId, w, h, paint) {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x1a1d24, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(250, 320, 180);
    scene.add(key);
    const back = new THREE.DirectionalLight(0x9fd8ff, 0.9);
    back.position.set(-260, 120, -220);
    scene.add(back);
    const sim = new Game.CarSim(Game.CarConfigOctane);
    const view = new CarView(scene, sim, paint[0], paint[1], carId);
    view.update(new THREE.Vector3(), new THREE.Quaternion(), 0, CarView.liveData(sim));
    const cam = new THREE.PerspectiveCamera(30, w / h, 10, 5000);
    cam.position.set(205, 85, 175);
    cam.lookAt(8, 6, 0);
    const rt = new THREE.WebGLRenderTarget(w, h);
    rt.texture.encoding = THREE.sRGBEncoding;
    const prevTarget = renderer.getRenderTarget(), prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    rt.dispose();
    view.dispose();
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  class BallView {
    constructor(scene, radiusUU) {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 512;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0, '#d9dfe8'); g.addColorStop(0.5, '#f7f9fc'); g.addColorStop(1, '#d9dfe8');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
      const R = 44, h = Math.sqrt(3) * R;
      ctx.lineWidth = 5; ctx.strokeStyle = '#4f5866';
      for (let row = -1; row < 512 / h + 1; row++) {
        for (let col = -1; col < 1024 / (1.5 * R) + 1; col++) {
          const cx = col * 1.5 * R, cy = row * h + (col % 2 ? h / 2 : 0);
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 3 * k;
            ctx[k ? 'lineTo' : 'moveTo'](cx + R * Math.cos(a), cy + R * Math.sin(a));
          }
          ctx.closePath();
          if ((row * 7 + col * 3) % 5 === 0) { ctx.fillStyle = '#2b323e'; ctx.fill(); }
          ctx.stroke();
        }
      }
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 8;

      this.mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radiusUU, 48, 32),
        new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.4, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.2 })
      );
      this.mesh.castShadow = true;
      scene.add(this.mesh);

      // Ring on the floor under the ball while it's in the air
      this.marker = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1, 64),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      );
      this.marker.rotation.x = -Math.PI / 2;
      this.marker.renderOrder = 2;
      scene.add(this.marker);
      this.radiusUU = radiusUU;
      this.visible = true;
      onModels(m => this.useModel(m));
    }

    // Swap the built-in sphere for the imported ball model, scaled to the visual ball size
    useModel(m) {
      const b = m.ball;
      if (!b) return;
      const s = (this.radiusUU + 1.5) / b.radius;
      const group = new THREE.Group();
      const main = new THREE.Mesh(b.main, b.material);
      main.castShadow = true;
      group.add(main);
      b.lights.forEach(g => group.add(new THREE.Mesh(g, b.lightMaterial)));
      group.scale.setScalar(s);
      group.position.copy(b.center).multiplyScalar(-s);
      this.mesh.material.visible = false;
      this.mesh.add(group);
    }

    setVisible(v) { this.visible = v; this.mesh.visible = v; this.marker.visible = v; }

    update(position, quaternion) {
      this.mesh.position.copy(position);
      this.mesh.quaternion.copy(quaternion);
      const height = Math.max(0, position.y - 93);
      const show = Math.min(1, Math.max(0, (height - 60) / 140));
      this.marker.visible = this.visible && show > 0;
      this.marker.position.set(position.x, 2, position.z);
      this.marker.material.opacity = 0.8 * show;
      this.marker.scale.setScalar(this.radiusUU * (1.05 + Math.min(height, 2000) / 2000 * 0.5));
    }
  }

  // Arrow on the ground around the player's car pointing toward the ball (shown in ball cam)
  class BallArrow {
    constructor(scene) {
      const s = new THREE.Shape();
      s.moveTo(20, 0); s.lineTo(-10, 14); s.lineTo(-3, 0); s.lineTo(-10, -14); s.closePath();
      const g = new THREE.ShapeGeometry(s);
      g.rotateX(-Math.PI / 2); // lie flat, pointing along +X
      this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xeafcff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      this.mesh.renderOrder = 3;
      this.mesh.visible = false;
      this.opacity = 0;
      scene.add(this.mesh);
    }

    update(dt, carPos, carQuat, ballPos, show) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(carQuat);
      const toBall = ballPos.clone().sub(carPos);
      const flat = toBall.addScaledVector(up, -toBall.dot(up));
      const dist = flat.length();
      const target = show && dist > 260 ? 0.85 : 0;
      this.opacity += (target - this.opacity) * (1 - Math.exp(-10 * dt));
      this.mesh.visible = this.opacity > 0.01 && dist > 1e-3;
      this.mesh.material.opacity = this.opacity;
      if (!this.mesh.visible) return;
      flat.divideScalar(dist);
      _m.makeBasis(flat, up, new THREE.Vector3().crossVectors(flat, up));
      this.mesh.quaternion.setFromRotationMatrix(_m);
      this.mesh.position.copy(carPos).addScaledVector(flat, 115).addScaledVector(up, -14);
    }
  }

  return { CarView, BallView, BallArrow, CARS, toThreePos, toThreeQuat, loadModels, onModels, renderThumbnail };
})();
