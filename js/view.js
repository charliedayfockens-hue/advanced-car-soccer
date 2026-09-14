// Car and ball visuals. The car is an original boxy hot-hatch design built from primitives and
// sized around the simulated Octane hitbox; wheels follow the simulated suspension length,
// steering angle and ground speed.
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

  // ---------------- imported models (assets/car, assets/ball) ----------------
  const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  const models = { ready: false, car: null, ball: null, listeners: [] };

  function onModels(fn) { if (models.ready) fn(models); else models.listeners.push(fn); }

  function loadModels() {
    if (models.loading || !THREE.FBXLoader) {
      if (!THREE.FBXLoader) { models.ready = true; }
      return;
    }
    models.loading = true;
    // The FBX files point at textures on their authors' disks; we assign ours afterwards
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => (/\.(png|jpe?g|tga)$/i.test(url) ? BLANK_PNG : url));
    const loader = new THREE.FBXLoader(manager);
    const tex = (url, srgb) => { const t = Game.Assets.texture(url); if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t; };
    // Downloads are checked by Game.Assets so a broken deploy is reported instead of silently skipped
    const loadFbx = url => Game.Assets.fetchChecked(url, { kind: 'FBX', check: Game.Assets.isFbx })
      .then(buf => loader.parse(buf, url.slice(0, url.lastIndexOf('/') + 1)))
      .catch(err => { Game.Assets.report(err, url); return null; });

    Promise.all([loadFbx('assets/car/Fennec.fbx'), loadFbx('assets/ball/Ball.fbx')]).then(([car, ball]) => {
      try { if (car) models.car = prepareCar(car, tex); } catch (e) { console.warn('Car model setup failed', e); }
      try { if (ball) models.ball = prepareBall(ball, tex); } catch (e) { console.warn('Ball model setup failed', e); }
      models.ready = true;
      models.listeners.splice(0).forEach(fn => fn(models));
    });
  }

  // Model frame: +X forward, +Y up, +Z left, uu, ground at y = -1.5. Wheels are separate meshes.
  function prepareCar(obj, tex) {
    const T = n => 'assets/car/' + n;
    const chassis = new THREE.MeshStandardMaterial({ map: tex(T('Chassis_Grain_D.png'), true), normalMap: tex(T('Chassis_Grain_N.png')), roughness: 0.55, metalness: 0.35 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x05070b, roughness: 0.05, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f6ff, emissiveIntensity: 1.8 });
    const rim = new THREE.MeshStandardMaterial({ map: tex(T('Alpha_D.png'), true), normalMap: tex(T('Alpha_N.png')), roughness: 0.3, metalness: 0.85 });
    const tread = new THREE.MeshStandardMaterial({ color: 0x141416, normalMap: tex(T('NormalMap.png')), roughness: 0.9 });
    const role = r => { const m = new THREE.MeshStandardMaterial(); m.userData.role = r; return m; };
    const primary = role('primary'), accent = role('accent');
    const pick = m => {
      const n = m.name || '';
      if (/chassis/i.test(n)) return chassis;
      if (/window/i.test(n)) return glass;
      if (/headlight/i.test(n)) return lamp;
      if (/rim/i.test(n)) return rim;
      if (/tread/i.test(n)) return tread;
      if (/body/i.test(n)) return primary;
      if (/paint/i.test(n)) return accent;
      return chassis;
    };
    const wheelIndex = { FR: 0, FL: 1, BR: 2, BL: 3 };
    const out = { body: null, wheels: [] };
    obj.updateMatrixWorld(true);
    obj.traverse(o => {
      if (!o.isMesh) return;
      const mats = [].concat(o.material).map(pick);
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const m = /_(FL|FR|BL|BR)_/.exec(o.name);
      if (m) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox, c = bb.getCenter(new THREE.Vector3());
        geo.translate(-c.x, -c.y, -c.z);
        out.wheels.push({ geometry: geo, material: mats.length === 1 ? mats[0] : mats, index: wheelIndex[m[1]], radius: (bb.max.y - bb.min.y) / 2 });
      } else {
        out.body = { geometry: geo, material: mats.length === 1 ? mats[0] : mats };
      }
    });
    return out;
  }

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
    constructor(scene, sim, color, accentColor) {
      this.sim = sim;
      this.accentColor = accentColor === undefined ? 0xff2fb3 : accentColor;
      this.group = new THREE.Group();
      this.body = new THREE.Group();
      this.group.add(this.body);
      this.wheelSpin = [0, 0, 0, 0];
      this.baseColor = color;

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
        const hole = new THREE.Path();
        hole.moveTo(-R - flat + 0.01, 0.01);
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
      this.wheels = sim.wheels.map((w, i) => {
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

    // Swap the built-in body and wheels for the imported car model
    useModel(m) {
      if (!m.car || !m.car.body || this.disposed) return;
      const swap = mat => (mat.userData.role === 'primary' ? this.paint : mat.userData.role === 'accent' ? this.roofMat : mat);
      const bodyMat = Array.isArray(m.car.body.material) ? m.car.body.material.map(swap) : swap(m.car.body.material);
      const body = new THREE.Mesh(m.car.body.geometry, bodyMat);
      // mirror Z (model has +Z left), line its wheels up with the simulated wheel positions
      body.scale.set(1, 1, -1);
      body.position.set(5.8, -15.5, 0);
      body.castShadow = true;
      this.group.add(body);
      this.body.visible = false;
      this.modelBody = body;
      m.car.wheels.forEach(w => {
        const v = this.wheels[w.index];
        if (!v) return;
        v.spin.children.forEach(c => { c.visible = false; });
        const mesh = new THREE.Mesh(w.geometry, w.material);
        mesh.scale.set(1, 1, -1);
        mesh.castShadow = true;
        v.spin.add(mesh);
        v.radius = w.radius;
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
        const c = w.connectionCS;
        v.pivot.position.set(c.x * BT, (c.z - d.wheels[i][0]) * BT, c.y * BT);
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

      this.marker = new THREE.Mesh(
        new THREE.CircleGeometry(radiusUU * 0.9, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
      );
      this.marker.rotation.x = -Math.PI / 2;
      scene.add(this.marker);
      this.radiusUU = radiusUU;
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

    setVisible(v) { this.mesh.visible = v; this.marker.visible = v; }

    update(position, quaternion) {
      this.mesh.position.copy(position);
      this.mesh.quaternion.copy(quaternion);
      const height = Math.max(0, position.y - 93);
      this.marker.position.set(position.x, 1.5, position.z);
      this.marker.material.opacity = Math.max(0, 0.38 - height / 5000);
      const k = 1 + height / 2500;
      this.marker.scale.set(k, k, k);
    }
  }

  return { CarView, BallView, toThreePos, toThreeQuat, loadModels, onModels };
})();
