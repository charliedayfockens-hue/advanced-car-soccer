// Bootstrap and game loop. Fixed 120 Hz RocketSim ticks with interpolated rendering.
// Flow: main menu -> (Free Play | 1v1 vs bot) -> kickoff countdown -> play -> goal explosion ->
// replay -> kickoff ... -> (1v1) end screen.
(function () {
  const S = Game.Settings, RL = Game.RL, BT = RL.BT_TO_UU;
  const { toThreePos, toThreeQuat } = Game.View;
  const TEAM_COLOR = { blue: 0x2f7dff, orange: 0xff7a1a };
  const PAINT = { freeplay: [0xff7f1f, 0xff2fb3], blue: [0x2a6cff, 0x5fe3ff], orange: [0xff7a1a, 0xffd23f] };
  const MATCH_SECONDS = 300;

  const canvas = document.getElementById('game-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  const scene = new THREE.Scene();
  const world = new Game.World.World();
  Game.Input.init(canvas);
  Game.View.loadModels();
  Game.Bots.loadElement().catch(() => {}); // preload so 1v1 starts instantly; failures show on screen

  const ballView = new Game.View.BallView(scene, RL.BALL_COLLISION_RADIUS_SOCCAR);
  const effects = new Game.Effects.Effects(scene);
  const chase = new Game.ChaseCamera.ChaseCamera(window.innerWidth / Math.max(window.innerHeight, 1));
  const recorder = new Game.Replay.Recorder(9);

  const score = { blue: 0, orange: 0 };
  const session = { mode: 'freeplay', opponent: null, bot: null, clock: 0, overtime: false, matchOver: false };
  let stadium = null, builtTheme = null;
  let carViews = [];

  // ---------- post processing ----------
  let composer = null, bloom = null, speedPass = null;
  if (THREE.EffectComposer && THREE.UnrealBloomPass && THREE.GammaCorrectionShader) {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, chase.camera));
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.9);
    composer.addPass(bloom);
    speedPass = new THREE.ShaderPass(Game.Effects.SpeedShader);
    speedPass.enabled = false;
    composer.addPass(speedPass);
    composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));
  }

  function applyEnv(obj) {
    if (!stadium || !stadium.envMap) return;
    obj.traverse(o => {
      if (!o.isMesh || !o.material) return;
      [].concat(o.material).forEach(m => {
        if (!m.isMeshStandardMaterial || m.envMap === stadium.envMap) return;
        m.envMap = stadium.envMap;
        m.needsUpdate = true;
      });
    });
  }

  // ---------- cars ----------
  const snap = () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion() });
  let carPrev = [], carCurr = [], carDraw = [];
  const ballPrev = snap(), ballCurr = snap(), ballDraw = snap();

  function capture(cars, ball) {
    world.cars.forEach((c, i) => { toThreePos(c.body.pos, cars[i].pos); toThreeQuat(c.body.rot, cars[i].quat); });
    toThreePos(world.ball.pos, ball.pos);
    toThreeQuat(world.ball.rot, ball.quat);
  }
  function syncRender() { capture(carPrev, ballPrev); capture(carCurr, ballCurr); }

  function buildCarViews() {
    carViews.forEach(v => v.dispose());
    carPrev = world.cars.map(snap); carCurr = world.cars.map(snap); carDraw = world.cars.map(snap);
    carViews = world.cars.map((car, i) => {
      const paint = session.mode === 'freeplay' && i === 0 ? PAINT.freeplay : PAINT[car.team];
      const v = new Game.View.CarView(scene, car, paint[0], paint[1]);
      v.setTheme(builtTheme || 'realistic');
      v.setShowHitbox(i === 0 && S.get('training').showHitbox);
      v.setBoostStyle(i === 0 ? S.get('graphics').boostStyle : 'standard');
      applyEnv(v.group);
      return v;
    });
    Game.View.onModels(() => carViews.forEach(v => applyEnv(v.group)));
    syncRender();
  }

  // ---------- settings ----------
  S.on('graphics', g => {
    if (g.theme !== builtTheme) {
      if (stadium) stadium.dispose();
      stadium = Game.Stadium.build(scene, { theme: g.theme, boostPads: world.boostPads, renderer });
      stadium.setScore(score.blue, score.orange);
      builtTheme = g.theme;
      carViews.forEach(v => { v.setTheme(g.theme); applyEnv(v.group); });
      applyEnv(ballView.mesh);
      Game.View.onModels(() => applyEnv(ballView.mesh));
      if (bloom) bloom.strength = g.theme === 'arcade' ? 0.3 : 0.5;
    }
    stadium.setShowStadium(g.showStadium);
    if (carViews[0]) carViews[0].setBoostStyle(g.boostStyle);
  });
  S.on('audio', a => Game.Audio.setVolume(a.volume));
  S.on('training', t => {
    if (session.mode === 'freeplay' && t.boost !== world.boostMode) {
      world.setBoostMode(t.boost);
      if (t.boost === 'standard') world.car.state.boost = 100 / 3;
    }
    if (carViews[0]) carViews[0].setShowHitbox(t.showHitbox);
  });

  function quatFromArr(q, out) { return toThreeQuat(Game.Math.Mat3.fromQuat(q), out); }

  // Average contact normal of the wheels touching something (three.js axes), or null when none do
  function wheelGroundNormal(car) {
    const n = new THREE.Vector3();
    car.wheels.forEach(w => { if (w.inContact) n.add(new THREE.Vector3(w.contactNormalWS.x, w.contactNormalWS.z, w.contactNormalWS.y)); });
    return n.lengthSq() > 0 ? n.normalize() : null;
  }

  // ---------- game flow ----------
  let state = 'menu';
  let simTime = 0, playTime = 0, menuTime = 0;
  let goal = null, replay = null;
  let countdownT = 0, countdownStep = -1;
  let goalLatch = false, debugFreeze = false;
  let flipResetFlag = false, wasSupersonic = false, speedAmount = 0;

  const fmtClock = s => { const t = Math.max(0, Math.ceil(s - 1e-6)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

  function setScoreboard() {
    Game.UI.setScore(score.blue, score.orange);
    if (stadium) stadium.setScore(score.blue, score.orange);
  }

  function hideBall() {
    const b = world.ball;
    b.pos = new Game.Math.Vec3(0, 0, -3000 * RL.UU_TO_BT);
    b.linVel = new Game.Math.Vec3();
    b.angVel = new Game.Math.Vec3();
  }

  // opponentId: the 1v1 opponent, or the free play bot ('none' for no bot)
  async function startSession(mode, opponentId) {
    const forMode = Game.Bots.OPPONENTS.filter(o => o.modes.includes(mode));
    session.mode = mode;
    session.opponent = forMode.find(o => o.id === opponentId) || (mode === '1v1' ? forMode[0] : null);
    session.botOptions = { mirrorAxis: S.get('menu').mirrorAxis };
    session.overtime = false;
    session.matchOver = false;
    session.clock = mode === '1v1' ? MATCH_SECONDS : 0;
    const botTeam = session.opponent && (session.opponent.team ? session.opponent.team(session.botOptions) : 'orange');
    world.setTeams(botTeam ? ['blue', botTeam] : ['blue']);
    world.setBoostMode(mode === '1v1' ? 'standard' : S.get('training').boost);
    world.resetKickoff();
    buildCarViews();
    score.blue = score.orange = 0;
    setScoreboard();
    Game.UI.setMatchInfo(mode === '1v1'
      ? { blueName: 'YOU', orangeName: session.opponent.name.toUpperCase(), modeLabel: '1V1 MATCH' }
      : { blueName: 'BLUE', orangeName: 'ORANGE', modeLabel: 'FREE PLAY' });
    Game.UI.hideMainMenu();
    Game.UI.hideEnd();
    session.bot = null;
    state = 'loading';
    if (session.opponent) {
      try {
        await session.opponent.load();
        session.bot = session.opponent.make(world, 1, session.botOptions);
      } catch (e) {
        console.warn(e);
        if (mode === '1v1') {
          Game.UI.toast(session.opponent.name + " couldn't load (see bottom-left), playing Rookie instead");
          session.bot = Game.Bots.OPPONENTS.find(o => o.id === 'rookie').make(world, 1);
        } else {
          Game.UI.toast(session.opponent.name + " couldn't load (see bottom-left)");
        }
      }
    }
    startKickoff();
    Game.Input.requestPointerLock();
  }

  function goToMenu() {
    state = 'menu';
    session.mode = 'freeplay';
    session.bot = null;
    session.opponent = null;
    Game.UI.showReplay(false);
    Game.UI.hideGoal();
    Game.UI.countdown(null);
    Game.UI.hideEnd();
    world.setTeams(['blue']);
    world.setBoostMode(S.get('training').boost);
    world.resetKickoff();
    buildCarViews();
    ballView.setVisible(true);
    chase.reset();
    Game.Input.exitPointerLock();
    Game.UI.showMainMenu({ opponents: Game.Bots.OPPONENTS, onStart: startSession });
  }

  function onGoal(team) {
    score[team]++;
    Game.UI.setScore(score.blue, score.orange, team);
    stadium.setScore(score.blue, score.orange);
    const pos = toThreePos(world.ball.pos);
    effects.goalExplosion(pos, TEAM_COLOR[team]);
    Game.Audio.goal();
    Game.UI.showGoal(team);

    if (session.mode === 'freeplay' && S.get('training').disableGoalReset) {
      setTimeout(() => Game.UI.hideGoal(), 1600);
      return;
    }
    if (session.mode === '1v1' && session.overtime) session.matchOver = true;
    state = 'goal';
    goal = { team, time: simTime, pos, t: 0 };
    lockBallCam(true);
    hideBall();
  }

  // Ball cam is unavailable from a goal until the next kickoff, when the player's choice comes back.
  let camLock = null;
  function lockBallCam(on) {
    if (on && camLock === null) { camLock = chase.ballCam; chase.ballCam = false; }
    else if (!on && camLock !== null) { chase.ballCam = camLock; camLock = null; }
    Game.UI.setCam(chase.ballCam);
  }
  function toggleCam() {
    if (camLock === null) Game.UI.setCam(chase.toggleBallCam());
  }

  function startReplay() {
    const clip = recorder.freeze(goal.time - 5.5, goal.time + 1.3);
    Game.UI.hideGoal();
    if (clip.frames.length < 20) return afterReplay();
    replay = { clip, t: clip.startTime, goalTime: goal.time, team: goal.team, exploded: false, pos: goal.pos };
    state = 'replay';
    chase.replayPos = null;
    Game.UI.showReplay(true);
    Game.Audio.whoosh();
  }

  function afterReplay() {
    if (session.matchOver) endMatch();
    else startKickoff();
  }

  function resetCommon() {
    lockBallCam(false);
    Game.UI.showReplay(false);
    Game.UI.hideGoal();
    ballView.setVisible(true);
    world.resetKickoff();
    recorder.clear();
    chase.reset();
    syncRender();
    replay = null;
    goal = null;
    flipResetFlag = false;
    if (session.bot) session.bot.reset();
  }

  function startKickoff() {
    resetCommon();
    state = 'countdown';
    countdownT = 0;
    countdownStep = -1;
  }

  function resetShot() {
    resetCommon();
    Game.UI.countdown(null);
    state = 'play';
  }

  function endMatch() {
    state = 'ended';
    Game.UI.showReplay(false);
    Game.UI.hideGoal();
    const win = score.blue > score.orange;
    Game.UI.showEnd({
      title: win ? 'VICTORY' : 'DEFEAT',
      win,
      blue: score.blue,
      orange: score.orange,
      sub: (session.overtime ? 'Won in overtime' : 'Full time') + ' · vs ' + session.opponent.name,
      onAgain: () => startSession('1v1', session.opponent.id),
      onMenu: goToMenu
    });
    if (win) Game.Audio.goal();
  }

  function updateMatchClock(dt) {
    if (session.mode !== '1v1') { session.clock += dt; return; }
    if (world.kickoffPause) return; // clock waits for the kickoff touch, like RL
    if (session.overtime) { session.clock += dt; return; }
    session.clock -= dt;
    if (session.clock <= 0) {
      session.clock = 0;
      if (score.blue !== score.orange) {
        endMatch();
      } else {
        session.overtime = true;
        Game.UI.toast('OVERTIME');
        Game.Audio.countdown(true);
        startKickoff();
      }
    }
  }

  function clockText() {
    if (session.mode === '1v1' && session.overtime) return '+' + fmtClock(session.clock);
    return fmtClock(session.clock);
  }

  function handleEvents(ev) {
    for (const e of ev) {
      const car = world.cars[e.car];
      switch (e.type) {
        case 'ballHit':
          Game.Audio.carBallHit(e.strength);
          if (car) effects.ballHit(toThreePos(world.ball.pos).lerp(toThreePos(car.body.pos), 0.45), e.strength);
          break;
        case 'ballBounce': Game.Audio.ballBounce(e.strength); break;
        case 'carImpact':
          Game.Audio.carImpact(e.strength);
          if (car) effects.dust(toThreePos(car.body.pos), e.strength);
          break;
        case 'bump': Game.Audio.carImpact(e.strength); break;
        case 'demo': {
          const victim = world.cars[e.victim];
          effects.goalExplosion(toThreePos(victim.body.pos), victim.team === 'blue' ? TEAM_COLOR.blue : TEAM_COLOR.orange);
          Game.Audio.sonicBoom();
          if (e.attacker === 0) Game.UI.toast('DEMOLITION!');
          if (e.victim === 0) Game.UI.toast('DEMOLISHED');
          break;
        }
        case 'jump': if (e.car === 0) Game.Audio.jump(); break;
        case 'flip': if (e.car === 0) { Game.Audio.flip(); flipResetFlag = false; } break;
        case 'flipReset':
          if (e.car === 0) {
            flipResetFlag = true;
            Game.UI.flipResetPopup();
            Game.Audio.flipReset();
          }
          if (car) effects.flipReset(toThreePos(car.body.pos));
          break;
        case 'boostPickup':
          if (car) effects.boostPickup(toThreePos(car.body.pos), e.big);
          if (e.car === 0) Game.Audio.uiSelect();
          break;
      }
    }
  }

  // Flip availability for the player, from RocketSim's CarState::HasFlipOrJump / HasFlipReset
  function updateFlipIndicator(hidden) {
    const s = world.car.state;
    if (hidden || world.car.isDemoed) return Game.UI.setFlip('hidden', 0);
    if (s.isOnGround) { flipResetFlag = false; return Game.UI.setFlip('ground', 1); }
    const hasFlipOrJump = !s.hasFlipped && !s.hasDoubleJumped && s.airTimeSinceJump < RL.DOUBLEJUMP_MAX_DELAY;
    if (!hasFlipOrJump) { flipResetFlag = false; return Game.UI.setFlip('used', 0); }
    if (flipResetFlag && !s.hasJumped) return Game.UI.setFlip('reset', 1);
    Game.UI.setFlip('ready', s.hasJumped ? 1 - s.airTimeSinceJump / RL.DOUBLEJUMP_MAX_DELAY : 1);
  }

  // ---------- resize ----------
  function onResize() {
    const w = Math.max(window.innerWidth, 1), h = Math.max(window.innerHeight, 1);
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
    if (speedPass) speedPass.uniforms.aspect.value = w / h;
    chase.setAspect(w / h);
  }
  window.addEventListener('resize', onResize);
  onResize();

  Game.UI.init({ canvas, onToggleCam: toggleCam, onLeave: goToMenu });
  Game.UI.setScore(0, 0);
  Game.UI.setCam(chase.ballCam);

  // ---------- stats ----------
  const stats = { frameTimes: [], breakdown: { sim: 0, scene: 0, camera: 0, render: 0 }, tickRate: 0, dropped: 0, budget: 16.7, renderer: renderer.info };
  let ticksThisSecond = 0, tickWindow = 0, statusTimer = 0;
  const ema = (key, v) => { stats.breakdown[key] += (v - stats.breakdown[key]) * 0.1; };

  // ---------- loop ----------
  const TICK = world.tickTime;
  let accumulator = 0;
  let last = performance.now(), lastRender = 0;

  function frame(now, manual) {
    if (!manual) requestAnimationFrame(frame);
    const g = S.get('graphics');
    if (!manual && g.limitFps && now - lastRender < 1000 / g.maxFps - 0.5) return;
    const rawDt = Math.max((now - last) / 1000, 0);
    lastRender = now;
    last = now;
    const dt = Math.min(rawDt, 0.25);
    stats.frameTimes.push(rawDt * 1000);
    if (stats.frameTimes.length > 240) stats.frameTimes.shift();
    stats.budget = g.limitFps ? 1000 / g.maxFps : 1000 / 60;

    const I = Game.Input;
    I.updateFrame();
    Game.UI.menuUpdate(dt);
    const bindings = S.get('controls').bindings;
    if (!Game.UI.isMenuOpen() && state !== 'menu' && bindings.menu.pad.some(b => b.type === 'button' && I.padButtonPressed(b.index))) Game.UI.openSettings();
    const paused = Game.UI.isMenuOpen() || debugFreeze;
    const inMenu = state === 'menu' || state === 'loading' || state === 'ended';

    let t0 = performance.now();
    if (!paused && !inMenu) {
      if (I.wasPressed('ballCam')) toggleCam();
      if (session.mode === 'freeplay' && I.wasPressed('resetShot')) resetShot();

      if (state === 'play' && session.mode === 'freeplay') {
        ['takePossession', 'startDribble', 'passBall', 'launchBall'].forEach(k => { if (I.wasPressed(k)) world.ballControl(k); });
      }
      if (state === 'play') {
        playTime += dt;
        if (playTime > 15) Game.UI.fadeHint();
      }

      if (state === 'play' || state === 'goal') {
        accumulator += dt;
        const playerControls = I.buildControls();
        let steps = 0;
        while (accumulator >= TICK && steps < 10) {
          capture(carPrev, ballPrev);
          const controls = [Object.assign({}, playerControls)];
          if (session.bot) controls[1] = session.bot.tick();
          world.step(controls);
          if (session.bot && session.bot.afterStep) session.bot.afterStep();
          capture(carCurr, ballCurr);
          simTime += TICK;
          accumulator -= TICK;
          steps++;
          ticksThisSecond++;
          recorder.record(world, simTime, state === 'goal');
          handleEvents(world.events);

          if (state === 'play') {
            const team = world.scoredGoal();
            if (team && !goalLatch) { goalLatch = true; onGoal(team); }
            if (!team) goalLatch = false;
            if (state !== 'play') break;
          }
        }
        if (steps === 10 && accumulator >= TICK) { stats.dropped += Math.floor(accumulator / TICK); accumulator = 0; }
        if (state === 'play') updateMatchClock(dt);
      }

      if (state === 'goal') {
        goal.t += dt;
        if (goal.t > 2.8) startReplay();
      } else if (state === 'replay') {
        const r = replay;
        const nearGoal = Math.abs(r.t - r.goalTime) < 0.45;
        r.t += dt * (nearGoal ? 0.35 : 1);
        if (!r.exploded && r.t >= r.goalTime) {
          r.exploded = true;
          effects.goalExplosion(r.pos, TEAM_COLOR[r.team]);
          Game.Audio.goal();
        }
        Game.UI.setReplayProgress((r.t - r.clip.startTime) / (r.clip.endTime - r.clip.startTime));
        if (r.t >= r.clip.endTime || (I.wasPressed('jump') && r.t - r.clip.startTime > 0.3)) afterReplay();
      } else if (state === 'countdown') {
        countdownT += dt;
        const step = Math.floor(countdownT / 0.8);
        if (step !== countdownStep) {
          countdownStep = step;
          if (step < 3) { Game.UI.countdown(String(3 - step)); Game.Audio.countdown(false); }
          else if (step === 3) {
            Game.UI.countdown('GO!');
            Game.Audio.countdown(true);
            state = 'play';
            accumulator = 0;
            setTimeout(() => { if (state !== 'countdown') Game.UI.countdown(null); }, 800);
          }
        }
      }
    }
    ema('sim', performance.now() - t0);

    // ---------- scene ----------
    t0 = performance.now();
    const inReplay = state === 'replay' && replay;
    const datas = [];
    let ballVisible = true;
    if (inReplay) {
      const smp = replay.clip.sample(replay.t);
      const a = smp.a, b = smp.b, k = smp.alpha;
      world.cars.forEach((car, i) => {
        const ca = a.cars[i], cb = b.cars[i] || ca;
        if (!ca) { datas.push(null); return; }
        carDraw[i].pos.lerpVectors(toThreePos(ca.pos), toThreePos(cb.pos), k);
        quatFromArr(ca.quat, carDraw[i].quat).slerp(quatFromArr(cb.quat, new THREE.Quaternion()), k);
        datas.push({ fwdSpeed: ca.fwdSpeed, boosting: ca.boosting, supersonic: ca.supersonic, wheels: ca.wheels, speed: ca.speed, demoed: ca.demoed });
      });
      ballDraw.pos.lerpVectors(toThreePos(a.ballPos), toThreePos(b.ballPos), k);
      quatFromArr(a.ballQuat, ballDraw.quat).slerp(quatFromArr(b.ballQuat, new THREE.Quaternion()), k);
      ballVisible = !a.ballHidden && replay.t < replay.goalTime;
    } else {
      const alpha = paused || state !== 'play' && state !== 'goal' ? 1 : Math.min(accumulator / TICK, 1);
      world.cars.forEach((car, i) => {
        carDraw[i].pos.lerpVectors(carPrev[i].pos, carCurr[i].pos, alpha);
        carDraw[i].quat.copy(carPrev[i].quat).slerp(carCurr[i].quat, alpha);
        const d = Game.View.CarView.liveData(car);
        d.speed = car.body.linVel.length() * BT;
        d.demoed = car.isDemoed;
        datas.push(d);
      });
      ballDraw.pos.lerpVectors(ballPrev.pos, ballCurr.pos, alpha);
      ballDraw.quat.copy(ballPrev.quat).slerp(ballCurr.quat, alpha);
      ballVisible = state !== 'goal';
    }
    ballView.setVisible(ballVisible);

    const frameDt = paused ? 0 : dt;
    carViews.forEach((v, i) => {
      const d = datas[i];
      if (!d) { v.group.visible = false; return; }
      v.group.visible = !d.demoed;
      if (d.demoed) return;
      v.update(carDraw[i].pos, carDraw[i].quat, frameDt, d);
      if (d.boosting && !paused) {
        const vel = inReplay ? new THREE.Vector3() : toThreePos(world.cars[i].body.linVel);
        if (v.boostStyle === 'alpha') effects.boostAlpha(i, carDraw[i].pos, carDraw[i].quat, vel, d.supersonic, dt);
        else effects.boost(i, carDraw[i].pos, carDraw[i].quat, vel, d.supersonic, dt);
      }
    });
    ballView.update(ballDraw.pos, ballDraw.quat);

    const me = datas[0] || { supersonic: false, boosting: false, speed: 0 };
    if (!paused && !inMenu && me.supersonic && !wasSupersonic) {
      effects.sonicBoom(carDraw[0].pos, carDraw[0].quat);
      Game.Audio.sonicBoom();
    }
    wasSupersonic = me.supersonic;
    const sonic = me.supersonic && !inMenu;
    speedAmount += ((sonic ? 1 : 0) - speedAmount) * (1 - Math.exp(-(sonic ? 6 : 3) * dt));
    if (speedPass) {
      speedPass.enabled = speedAmount > 0.01;
      speedPass.uniforms.amount.value = speedAmount;
      speedPass.uniforms.time.value = now / 1000;
    }
    Game.UI.setSupersonic(sonic && !paused);

    effects.update(frameDt);
    stadium.update(carDraw[0] ? carDraw[0].pos : new THREE.Vector3(), frameDt, world.boostMode === 'standard' ? world.boostPads : null);
    ema('scene', performance.now() - t0);

    // ---------- camera ----------
    t0 = performance.now();
    const shake = effects.shakeOffset(dt, S.get('camera').cameraShake);
    if (inMenu) {
      menuTime += dt;
      const a = menuTime * 0.07;
      chase.camera.position.set(Math.sin(a) * 5200, 1500 + Math.sin(menuTime * 0.2) * 250, Math.cos(a) * 6400);
      chase.camera.up.set(0, 1, 0);
      chase.camera.lookAt(0, 250, 0);
      if (chase.camera.fov !== 75) chase.applyFov(75);
    } else if (inReplay) {
      const goalPos = new THREE.Vector3(0, 320, replay.team === 'blue' ? 5120 : -5120);
      chase.updateReplay(dt, carDraw[0].pos, ballDraw.pos, goalPos, replay.goalTime - replay.t, shake);
    } else {
      chase.update(dt, carDraw[0].pos, carDraw[0].quat, me.speed, ballDraw.pos, paused ? null : I, shake,
        { onGround: world.car.state.isOnGround, groundNormal: wheelGroundNormal(world.car),
          velocity: toThreePos(world.car.body.linVel), supersonic: me.supersonic });
    }
    effects.setViewportHeight(window.innerHeight, chase.camera.fov);
    ema('camera', performance.now() - t0);

    Game.Audio.update({
      active: !paused && !inMenu && state !== 'countdown',
      speed: me.speed,
      throttle: world.car.controls.throttle || 0,
      boosting: me.boosting,
      supersonic: me.supersonic,
      alpha: carViews[0] && carViews[0].boostStyle === 'alpha'
    });
    const s = world.car.state;
    Game.UI.updateHud({
      boost: s.boost,
      unlimited: world.boostMode !== 'standard',
      boosting: me.boosting,
      supersonic: me.supersonic,
      speed: me.speed,
      clockText: clockText()
    });
    updateFlipIndicator(inReplay || state === 'goal' || inMenu);

    t0 = performance.now();
    if (window.innerWidth > 0 && window.innerHeight > 0) {
      if (composer) composer.render(); else renderer.render(scene, chase.camera);
    }
    ema('render', performance.now() - t0);

    tickWindow += rawDt;
    if (tickWindow >= 1) { stats.tickRate = ticksThisSecond / tickWindow; ticksThisSecond = 0; tickWindow = 0; }
    statusTimer += rawDt;
    if (statusTimer > 0.1) { statusTimer = 0; Game.UI.drawStatus(stats); }

    I.endFrame();
  }

  buildCarViews();
  if (window.innerWidth > 0 && window.innerHeight > 0) {
    if (composer) composer.render(); else renderer.render(scene, chase.camera);
  }
  Game.UI.hideLoading();
  goToMenu();
  requestAnimationFrame(frame);

  window.GameDebug = {
    world, chase, scene, renderer, effects, recorder, session,
    get carViews() { return carViews; },
    get state() { return state; },
    start: startSession,
    menu: goToMenu,
    forceGoal(team) { if (state === 'play') onGoal(team || 'blue'); },
    set freeze(v) { debugFreeze = !!v; },
    get replayInfo() { return replay && { t: replay.t, start: replay.clip.startTime, end: replay.clip.endTime, goalTime: replay.goalTime }; },
    // Drive the loop manually (browsers pause requestAnimationFrame in background tabs)
    advance(seconds, fps = 60) {
      let t = last;
      for (let i = 0; i < seconds * fps; i++) { t += 1000 / fps; frame(t, true); }
      return state;
    }
  };
})();
