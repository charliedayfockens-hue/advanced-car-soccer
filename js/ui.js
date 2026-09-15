// HUD, overlays (goal, replay, countdown, toasts, status readout) and the settings menu:
// Camera / Controls / Graphics / Audio / Training / Status tabs built from Game.Settings,
// with mouse, keyboard and controller navigation.
window.Game = window.Game || {};

Game.UI = (function () {
  const $ = id => document.getElementById(id);
  const S = Game.Settings;
  const TABS = ['camera', 'controls', 'graphics', 'audio', 'training', 'status'];
  let currentTab = 'camera';
  let focusIndex = -1;
  let navCooldown = 0;
  let menuOpenedAt = 0;
  let wasLocked = false;

  // ---------------- small builders ----------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sectionHead(badge, title, desc) {
    const h = el('div', 'section-head');
    if (badge) h.appendChild(el('span', 'badge', badge));
    h.appendChild(el('h2', '', title));
    if (desc) h.appendChild(el('p', '', desc));
    return h;
  }

  function setFill(input) {
    const f = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--fill', f + '%');
  }

  function sliderRow(group, key, label, min, max, step, fmt, desc) {
    const row = el('div', 'setting-row');
    const lab = el('label', '', label);
    const input = el('input');
    Object.assign(input, { type: 'range', min, max, step });
    input.value = S.get(group)[key];
    const val = el('output', 'value', fmt(S.get(group)[key]));
    const apply = v => {
      v = Math.min(max, Math.max(min, Math.round(v / step) * step));
      v = parseFloat(v.toFixed(4));
      input.value = v;
      val.textContent = fmt(v);
      setFill(input);
      S.set(group, key, v);
    };
    input.addEventListener('input', () => apply(parseFloat(input.value)));
    setFill(input);
    row.append(lab, input, val);
    if (desc) { const d = el('div', 'desc', desc); d.style.gridColumn = '2 / 4'; row.appendChild(d); }
    row.padAdjust = dir => apply(parseFloat(input.value) + dir * step);
    return row;
  }

  function toggleRow(group, key, label, desc) {
    const row = el('div', 'setting-row toggle-row');
    row.appendChild(el('label', '', label));
    const sw = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!S.get(group)[key];
    input.addEventListener('change', () => { S.set(group, key, input.checked); Game.Audio.uiSelect(); });
    sw.append(input, el('span', 'knob'), el('span', 'desc', desc || ''));
    row.appendChild(sw);
    row.padActivate = () => { input.checked = !input.checked; input.dispatchEvent(new Event('change')); };
    row.padAdjust = row.padActivate;
    return row;
  }

  function selectRow(group, key, label, options, desc, parse) {
    const row = el('div', 'setting-row select-row');
    row.appendChild(el('label', '', label));
    const wrap = el('div');
    const select = el('select');
    options.forEach(o => { const opt = el('option', '', o.label); opt.value = o.value; select.appendChild(opt); });
    select.value = String(S.get(group)[key]);
    select.addEventListener('change', () => { S.set(group, key, parse ? parse(select.value) : select.value); Game.Audio.uiSelect(); });
    wrap.appendChild(select);
    if (desc) wrap.appendChild(el('div', 'desc', desc));
    row.appendChild(wrap);
    row.padAdjust = dir => {
      const i = (select.selectedIndex + dir + options.length) % options.length;
      select.selectedIndex = i;
      select.dispatchEvent(new Event('change'));
    };
    row.select = select;
    return row;
  }

  const fixed2 = v => Number(v).toFixed(2);
  const deg2 = v => Number(v).toFixed(2) + '°';

  // ---------------- tabs ----------------
  const builders = {
    camera(body) {
      body.appendChild(sectionHead('A', 'Framing', 'Adjust your view. Changes preview live in the arena.'));
      body.appendChild(sliderRow('camera', 'fov', 'Field of View', 60, 110, 1, v => v + '°'));
      body.appendChild(sliderRow('camera', 'distance', 'Distance', 100, 400, 10, fixed2));
      body.appendChild(sliderRow('camera', 'height', 'Height', 40, 200, 10, fixed2));
      body.appendChild(sliderRow('camera', 'angle', 'Angle', -15, 0, 1, deg2));
      body.appendChild(sectionHead('B', 'Response', 'How the camera follows the car.'));
      body.appendChild(sliderRow('camera', 'stiffness', 'Stiffness', 0, 1, 0.05, fixed2));
      body.appendChild(sliderRow('camera', 'swivelSpeed', 'Swivel Speed', 1, 10, 0.1, fixed2));
      body.appendChild(sliderRow('camera', 'transitionSpeed', 'Transition Speed', 1, 2, 0.1, fixed2));
      body.appendChild(toggleRow('camera', 'cameraShake', 'Camera Shake', 'Shake on big hits and hard landings.'));
      body.appendChild(toggleRow('camera', 'invertSwivel', 'Invert Swivel', 'Flips vertical look for ball cam and car cam.'));
    },

    controls(body) {
      const I = Game.Input, c = S.get('controls');
      body.appendChild(el('p', 'intro', 'Click a binding, then press the key, mouse button, controller button or stick direction it should use. Esc cancels. × removes a binding, + adds another.'));

      const pads = I.connectedPads();
      const devRow = selectRow('controls', 'device', 'Controller input',
        [{ value: 'auto', label: 'Automatic (first controller found)' }].concat(pads.map(p => ({ value: String(p.index), label: `${p.id} · ${p.index}` }))),
        'Which controller drives the car, the menus and the bindings. Press a button on it if it isn’t listed.');
      if (!pads.some(p => String(p.index) === c.device)) devRow.select.value = 'auto';
      body.appendChild(devRow);
      body.appendChild(sliderRow('controls', 'deadzone', 'Controller Dead Zone', 0, 0.5, 0.01, fixed2,
        'Ignore small stick movement near the centre. Raise it if the stick drifts, lower it for sharper response.'));

      const layout = I.pad ? I.padLayout() : 'xbox';
      const head = el('div', 'section-head');
      head.appendChild(el('h2', '', 'Control assignments'));
      head.appendChild(el('p', 'bind-layout', I.pad ? `${I.pad.id} · ${layout === 'playstation' ? 'PlayStation' : 'Xbox'} layout` : 'No controller connected · Xbox names shown'));
      body.appendChild(head);

      const table = el('table', 'bind-table');
      const thead = el('tr');
      ['Action', 'Keyboard / Mouse', 'Controller'].forEach(t => thead.appendChild(el('th', '', t)));
      table.appendChild(thead);

      let group = null;
      Game.Actions.forEach(action => {
        if (action.group !== group) {
          group = action.group;
          const tr = el('tr'), th = el('th', 'group', group);
          th.colSpan = 3;
          tr.appendChild(th);
          table.appendChild(tr);
        }
        const tr = el('tr');
        tr.dataset.action = action.id;
        const name = el('td');
        name.appendChild(el('div', 'bind-name', action.label));
        name.appendChild(el('div', 'bind-desc', action.desc));
        const hint = actionHint(action.id, c);
        if (hint) name.appendChild(el('div', 'bind-hint', hint));
        tr.appendChild(name);
        tr.appendChild(bindCell(action, 'keys', layout));
        tr.appendChild(bindCell(action, 'pad', layout));
        tr.padActivate = () => beginRebind(action, 'pad', -1);
        table.appendChild(tr);
      });
      body.appendChild(table);

      body.appendChild(sectionHead('', 'Stick Roles', 'Sticks steer and pitch as analog axes, like the real game.'));
      const axes = [0, 1, 2, 3].map(i => ({ value: String(i), label: I.axisName(i) }));
      body.appendChild(selectRow('controls', 'steerAxis', 'Steer / Yaw Axis', axes, '', v => parseInt(v, 10)));
      body.appendChild(toggleRow('controls', 'invertSteer', 'Invert Steer', 'Reverse the steering axis.'));
      body.appendChild(selectRow('controls', 'pitchAxis', 'Pitch Axis', axes, '', v => parseInt(v, 10)));
      body.appendChild(toggleRow('controls', 'invertPitch', 'Invert Pitch', 'Off: pushing the stick up tips the nose down.'));
      body.appendChild(sliderRow('controls', 'triggerThreshold', 'Trigger Threshold', 0.02, 0.9, 0.01, fixed2,
        'How far an analog trigger must be pulled before it counts as pressed.'));
    },

    graphics(body) {
      const g = S.get('graphics');
      body.appendChild(sectionHead('', 'Theme', 'Pick the look of the arena, car and effects. Saved automatically.'));
      const cards = el('div', 'theme-cards');
      [
        { id: 'realistic', name: 'Realistic', tag: 'DEFAULT', text: 'Detailed pitch, glossy paint, glass walls and a night stadium.' },
        { id: 'arcade', name: 'Arcade', tag: '', text: 'Bright painted colours, flat materials and a daytime sky.' }
      ].forEach(t => {
        const card = el('button', `theme-card ${t.id}` + (g.theme === t.id ? ' active' : ''));
        card.setAttribute('aria-pressed', g.theme === t.id);
        card.appendChild(el('div', 'swatch'));
        const title = el('b', '', t.name);
        card.appendChild(title);
        if (t.tag) card.appendChild(el('span', 'tag', t.tag));
        card.appendChild(el('p', '', t.text));
        const pick = () => {
          S.set('graphics', 'theme', t.id);
          cards.querySelectorAll('.theme-card').forEach(c => { c.classList.toggle('active', c === card); c.setAttribute('aria-pressed', c === card); });
          Game.Audio.uiSelect();
        };
        card.addEventListener('click', pick);
        card.padActivate = pick;
        cards.appendChild(card);
      });
      body.appendChild(cards);

      body.appendChild(sectionHead('', 'Frame Rate', 'How much rendering power to use.'));
      body.appendChild(toggleRow('graphics', 'limitFps', 'Limit FPS', 'Cap the frame rate to lower GPU usage.'));
      body.appendChild(sliderRow('graphics', 'maxFps', 'Maximum FPS', 60, 240, 1, v => String(v)));

      body.appendChild(sectionHead('', 'Scenery', 'Everything outside the playable arena.'));
      body.appendChild(toggleRow('graphics', 'showStadium', 'Show Stadium', 'Stands, roof, floodlights, scoreboard and sky.'));
    },

    audio(body) {
      body.appendChild(el('p', 'intro', 'One output level for every sound in the game. It applies instantly and is remembered next time.'));
      body.appendChild(sectionHead('', 'Master Output', 'Engine, boost, impact and goal audio.'));
      body.appendChild(sliderRow('audio', 'volume', 'Overall Volume', 0, 100, 1, v => v + '%'));
    },

    training(body) {
      body.appendChild(sectionHead('', 'Free Play', 'Practice session rules.'));
      body.appendChild(toggleRow('training', 'disableGoalReset', 'Disable Restart on Goal', 'Keep playing after a goal: no replay and no kickoff.'));
      body.appendChild(selectRow('training', 'boost', 'Boost', [{ value: 'unlimited', label: 'Unlimited' }, { value: 'standard', label: 'Standard' }],
        'Standard drains 33 boost per second and refills from the pads.'));
      body.appendChild(toggleRow('training', 'showHitbox', 'Show Car Hitbox', 'Outline the collision box around the car.'));
    },

    status(body) {
      body.appendChild(el('p', 'intro', 'The status readout sits in the top-left corner while you play. Choose what it shows.'));
      body.appendChild(sectionHead('', 'Overlay', 'What the readout includes.'));
      body.appendChild(toggleRow('status', 'show', 'Show Status Overlay', 'Draw the readout over the game.'));
      body.appendChild(toggleRow('status', 'frameTime', 'Frame Time', 'Average frame time plus p50, p95, p99 and the slowest frame.'));
      body.appendChild(toggleRow('status', 'history', 'History Plot', 'Recent frame times against the display refresh budget.'));
      body.appendChild(toggleRow('status', 'breakdown', 'Time Breakdown', 'CPU time spent on simulation, scene, camera and rendering.'));
      body.appendChild(toggleRow('status', 'simulation', 'Simulation', 'Physics tick rate and ticks dropped when the loop falls behind.'));
      body.appendChild(toggleRow('status', 'renderer', 'Renderer', 'Draw calls, triangles, geometries and textures in memory.'));
    }
  };

  function actionHint(id, c) {
    const I = Game.Input;
    if (id === 'throttle' || id === 'reverse') return 'pitch: ' + I.axisName(c.pitchAxis);
    if (id === 'steerLeft' || id === 'steerRight') return I.axisName(c.steerAxis);
    if (id === 'freeAirRoll') return 'held: ' + I.axisName(c.steerAxis) + ' rolls';
    if (id === 'airRollLeft' || id === 'airRollRight') return 'Trigger pull sets roll speed';
    return '';
  }

  function bindCell(action, device, layout) {
    const td = el('td');
    const cell = el('div', 'bind-cell');
    const list = S.get('controls').bindings[action.id][device];
    list.forEach((b, i) => {
      const chip = el('span', 'bind-chip');
      const label = device === 'keys' ? Game.Input.keyName(b) : Game.Input.padInputName(b, layout);
      const btn = el('button', '', label);
      btn.addEventListener('click', () => beginRebind(action, device, i));
      const x = el('button', 'x', '×');
      x.title = 'Remove';
      x.addEventListener('click', () => { Game.Input.removeBinding(action.id, device, i); renderTab(currentTab, 0, true); });
      chip.append(btn, x);
      cell.appendChild(chip);
    });
    const add = el('button', 'bind-add', '+');
    add.title = 'Add binding';
    add.addEventListener('click', () => beginRebind(action, device, -1));
    cell.appendChild(add);
    td.appendChild(cell);
    return td;
  }

  function beginRebind(action, device, slot) {
    $('rebind-action-name').textContent = (device === 'pad' ? 'Press a controller button or stick direction for ' : 'Press a key or mouse button for ') + '“' + action.label + '”';
    $('rebind-overlay').classList.remove('hidden');
    Game.Audio.uiSelect();
    Game.Input.startRebind(action.id, device, slot, () => {
      $('rebind-overlay').classList.add('hidden');
      renderTab('controls', 0, true);
    });
  }

  function renderTab(name, dir, keepScroll) {
    const body = $('settings-body');
    const scroll = body.scrollTop;
    currentTab = name;
    body.innerHTML = '';
    const content = el('div', 'tab-content' + (dir < 0 ? ' from-left' : ''));
    if (keepScroll) content.style.animation = 'none';
    builders[name](content);
    [...content.children].forEach((c, i) => { c.style.setProperty('--i', Math.min(i, 20)); if (keepScroll) c.style.animation = 'none'; });
    body.appendChild(content);
    body.scrollTop = keepScroll ? scroll : 0;
    focusIndex = -1;

    document.querySelectorAll('.tab-btn').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    moveUnderline();
  }

  function moveUnderline() {
    const active = document.querySelector('.tab-btn.active');
    const line = document.querySelector('.tab-underline');
    if (!active || !line) return;
    line.style.left = active.offsetLeft + 12 + 'px';
    line.style.width = active.offsetWidth - 24 + 'px';
  }

  function selectTab(name) {
    if (name === currentTab) return;
    const dir = TABS.indexOf(name) - TABS.indexOf(currentTab);
    renderTab(name, dir);
    Game.Audio.uiHover();
  }

  // ---------------- menu open / close / controller navigation ----------------
  const isMenuOpen = () => !$('settings-modal').classList.contains('hidden');

  function openSettings() {
    if (isMenuOpen()) return;
    $('settings-modal').classList.remove('hidden');
    $('settings-modal').classList.remove('peek');
    renderTab(currentTab, 0);
    requestAnimationFrame(moveUnderline);
    menuOpenedAt = performance.now();
    Game.Input.exitPointerLock();
    Game.Audio.whoosh();
  }

  function closeSettings() {
    if (Game.Input.isRebinding()) Game.Input.cancelRebind();
    $('settings-modal').classList.add('hidden');
    Game.Input.requestPointerLock();
    Game.Audio.uiSelect();
  }

  function focusables() {
    return [...$('settings-body').querySelectorAll('.setting-row, .theme-card, tr[data-action]'), $('restore-defaults'), $('settings-done')];
  }

  function setFocus(i) {
    const items = focusables();
    items.forEach(x => x.classList.remove('pad-focus'));
    focusIndex = (i + items.length) % items.length;
    const item = items[focusIndex];
    item.classList.add('pad-focus');
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    Game.Audio.uiHover();
  }

  function menuUpdate(dt) {
    const I = Game.Input;
    const modal = $('settings-modal');
    modal.classList.toggle('pad-active', !!I.pad);
    if (I.pad) {
      const ps = I.padLayout() === 'playstation';
      $('pad-select-key').textContent = ps ? 'Cross' : 'A';
      $('pad-back-key').textContent = ps ? 'Circle' : 'B';
    }
    if (!isMenuOpen() || !I.pad || I.isRebinding() || performance.now() - menuOpenedAt < 250) return;

    if (I.padButtonPressed(4)) return selectTab(TABS[(TABS.indexOf(currentTab) + TABS.length - 1) % TABS.length]);
    if (I.padButtonPressed(5)) return selectTab(TABS[(TABS.indexOf(currentTab) + 1) % TABS.length]);
    if (I.padButtonPressed(1) || I.padButtonPressed(9)) return closeSettings();

    navCooldown -= dt;
    const sy = I.pad.axes[1] || 0, sx = I.pad.axes[0] || 0;
    const up = I.padButtonDown(12) || sy < -0.6, down = I.padButtonDown(13) || sy > 0.6;
    const left = I.padButtonDown(14) || sx < -0.6, right = I.padButtonDown(15) || sx > 0.6;
    const anyNav = up || down || left || right;
    if (!anyNav) navCooldown = 0;
    if (anyNav && navCooldown <= 0) {
      navCooldown = navCooldown === 0 ? 0.35 : 0.09;
      if (up) setFocus(focusIndex < 0 ? 0 : focusIndex - 1);
      else if (down) setFocus(focusIndex + 1);
      else if (focusIndex >= 0) {
        const item = focusables()[focusIndex];
        if (item.padAdjust) item.padAdjust(left ? -1 : 1);
      }
    }
    if (I.padButtonPressed(0) && focusIndex >= 0) {
      const item = focusables()[focusIndex];
      if (item.padActivate) item.padActivate();
      else if (item.click) item.click();
    }
  }

  // ---------------- HUD ----------------
  function updateHud(d) {
    const arc = $('boost-arc');
    arc.style.strokeDashoffset = 235.6 * (1 - Math.max(0, Math.min(1, d.boost / 100)));
    $('boost-num').textContent = d.unlimited ? '∞' : Math.floor(d.boost);
    $('boost-gauge').classList.toggle('boosting', d.boosting);
    $('speed-value').textContent = Math.round(d.speed * 0.036);
    $('speed-fill').style.width = Math.min(d.speed / 2300, 1) * 100 + '%';
    $('supersonic').classList.toggle('on', d.supersonic);
    $('speed-box').classList.toggle('supersonic', d.supersonic);
    $('clock').textContent = d.clockText;
  }

  function setCam(ballCam) {
    $('cam-label').textContent = ballCam ? 'BALL CAM' : 'CAR CAM';
    $('cam-indicator').classList.toggle('on', ballCam);
  }

  function restartAnim(node) {
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
  }

  function setScore(blue, orange, team) {
    $('score-blue').textContent = blue;
    $('score-orange').textContent = orange;
    if (team) {
      const n = $(team === 'blue' ? 'score-blue' : 'score-orange');
      n.classList.remove('bump');
      void n.offsetWidth;
      n.classList.add('bump');
    }
  }

  function showGoal(team) {
    const b = $('goal-banner');
    b.className = team;
    $('goal-sub').textContent = team === 'blue' ? 'BLUE SCORES' : 'ORANGE SCORES';
    b.querySelectorAll('span, .goal-flash, .goal-sub').forEach(restartAnim);
  }
  function hideGoal() {
    const b = $('goal-banner');
    if (b.classList.contains('hidden')) return;
    b.classList.add('leaving');
    setTimeout(() => { b.className = 'hidden'; }, 480);
  }

  function showReplay(on) {
    const r = $('replay-overlay');
    r.classList.toggle('hidden', !on);
    $('hud').classList.toggle('replaying', on);
    if (on) {
      r.querySelectorAll('.replay-badge').forEach(restartAnim);
      const b = Game.Settings.get('controls').bindings.jump;
      const label = Game.Input.pad && b.pad[0] ? Game.Input.padInputName(b.pad[0]) : (b.keys[0] ? Game.Input.keyName(b.keys[0]) : 'Jump');
      $('skip-key').textContent = label;
    }
  }
  function setReplayProgress(f) { $('replay-fill').style.width = Math.max(0, Math.min(1, f)) * 100 + '%'; }

  function countdown(text) {
    const c = $('countdown'), n = $('countdown-num');
    if (text === null) { c.classList.add('hidden'); return; }
    c.classList.remove('hidden');
    n.textContent = text;
    n.className = '';
    void n.offsetWidth;
    n.className = text === 'GO!' ? 'go' : 'pop';
  }

  function toast(msg) {
    const t = el('div', 'toast', msg);
    $('toast-stack').appendChild(t);
    setTimeout(() => t.remove(), 2300);
  }

  function fadeHint() { $('controls-hint').classList.add('faded'); }

  // Flip indicator: ground (dim), ready (ring counts down the double-jump window), used, reset
  let lastFlip = '', flipTimer = 0;
  const FLIP_LABEL = { ground: 'FLIP', ready: 'FLIP', used: 'USED', reset: 'RESET', hidden: '' };
  function setFlip(state, frac) {
    if (state !== lastFlip) {
      $('flip-indicator').className = 'fi-' + state;
      $('fi-label').textContent = FLIP_LABEL[state];
      lastFlip = state;
    }
    $('fi-arc').style.strokeDashoffset = 194.8 * (1 - Math.max(0, Math.min(1, frac)));
  }
  function setSupersonic(on) { document.body.classList.toggle('supersonic', on); }

  // ---------------- garage ----------------
  const isGarageOpen = () => !$('garage-modal').classList.contains('hidden');

  function openGarage() {
    const list = $('garage-cars');
    list.innerHTML = '';
    const current = S.get('garage').car;
    (menuOpts.cars || []).forEach(c => {
      const b = el('button', 'garage-car' + (c.id === current ? ' active' : ''));
      b.dataset.id = c.id;
      const img = el('img', 'garage-thumb');
      img.alt = c.name;
      // Draw once the models are in, and again shortly after so late textures show up
      const draw = () => { if (!isGarageOpen()) return; try { img.src = menuOpts.renderCarThumbnail(c.id); } catch (e) { console.warn('Garage preview failed', e); } };
      Game.View.loadCar(c.id).then(() => { draw(); setTimeout(draw, 1500); setTimeout(draw, 4000); });
      b.append(img, el('div', 'garage-name', c.name), el('div', 'garage-desc', c.desc));
      b.addEventListener('click', () => {
        S.set('garage', 'car', c.id);
        list.querySelectorAll('.garage-car').forEach(x => x.classList.toggle('active', x.dataset.id === c.id));
        Game.Audio.uiSelect();
      });
      b.addEventListener('mouseenter', () => Game.Audio.uiHover());
      list.appendChild(b);
    });

    // Goal explosions
    const boom = $('garage-explosions');
    boom.innerHTML = '';
    const currentBoom = S.get('garage').explosion;
    Game.Effects.EXPLOSIONS.forEach(x => {
      const b = el('button', 'garage-explosion' + (x.id === currentBoom ? ' active' : ''));
      b.dataset.id = x.id;
      const rarity = el('div', 'garage-rarity rarity-' + x.rarity.toLowerCase().replace(/\s+/g, '-'), x.rarity);
      b.append(rarity, el('div', 'garage-name', x.name), el('div', 'garage-desc', x.desc));
      b.addEventListener('click', () => {
        S.set('garage', 'explosion', x.id);
        boom.querySelectorAll('.garage-explosion').forEach(y => y.classList.toggle('active', y.dataset.id === x.id));
        drawPaints();
        Game.Audio.uiSelect();
      });
      b.addEventListener('mouseenter', () => Game.Audio.uiHover());
      boom.appendChild(b);
    });

    // Colour swatches for the selected goal explosion (each explosion remembers its own colour)
    function drawPaints() {
      const g = S.get('garage');
      const x = Game.Effects.EXPLOSIONS.find(e => e.id === g.explosion) || Game.Effects.EXPLOSIONS[0];
      const current = (g.explosionPaints || {})[x.id] || 'unpainted';
      const paints = Game.Effects.PAINTS;
      $('garage-paint-label').textContent = x.name + ' Colour';
      $('garage-paint-name').textContent = (paints.find(p => p.id === current) || paints[0]).name;
      const wrap = $('garage-paints');
      wrap.innerHTML = '';
      paints.forEach(p => {
        const s = el('button', 'garage-paint' + (p.id === current ? ' active' : '') + (p.hex === null ? ' unpainted' : ''));
        s.title = p.name;
        s.setAttribute('aria-label', p.name);
        if (p.hex !== null) s.style.background = '#' + p.hex.toString(16).padStart(6, '0');
        s.addEventListener('click', () => {
          S.set('garage', 'explosionPaints', Object.assign({}, S.get('garage').explosionPaints, { [x.id]: p.id }));
          drawPaints();
          Game.Audio.uiSelect();
        });
        s.addEventListener('mouseenter', () => Game.Audio.uiHover());
        wrap.appendChild(s);
      });
    }
    drawPaints();

    // Player name (shown on the scoreboard and to others)
    const nameInput = $('garage-name-input');
    nameInput.value = S.get('profile').name;
    nameInput.oninput = () => S.set('profile', 'name', nameInput.value.slice(0, 16));
    $('garage-modal').classList.remove('hidden');
  }

  function closeGarage() { $('garage-modal').classList.add('hidden'); }

  // ---------------- status readout ----------------
  function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0; }

  function drawStatus(st) {
    const cfg = S.get('status');
    const box = $('status-overlay');
    box.classList.toggle('hidden', !cfg.show);
    if (!cfg.show) return;
    const lines = [];
    const ft = st.frameTimes;
    if (cfg.frameTime && ft.length) {
      const sorted = ft.slice().sort((a, b) => a - b);
      const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
      lines.push(`FRAME  ${avg.toFixed(2)} ms  (${(1000 / avg).toFixed(0)} fps)`);
      lines.push(`       p50 ${pct(sorted, 0.5).toFixed(1)}  p95 ${pct(sorted, 0.95).toFixed(1)}  p99 ${pct(sorted, 0.99).toFixed(1)}  max ${sorted[sorted.length - 1].toFixed(1)}`);
    }
    if (cfg.breakdown) {
      const b = st.breakdown;
      lines.push(`CPU    sim ${b.sim.toFixed(2)}  scene ${b.scene.toFixed(2)}  cam ${b.camera.toFixed(2)}  render ${b.render.toFixed(2)} ms`);
    }
    if (cfg.simulation) lines.push(`SIM    ${st.tickRate.toFixed(0)} ticks/s  dropped ${st.dropped}`);
    if (cfg.renderer) {
      const r = st.renderer;
      lines.push(`GPU    calls ${r.render.calls}  tris ${r.render.triangles}  geo ${r.memory.geometries}  tex ${r.memory.textures}`);
    }
    $('status-text').textContent = lines.join('\n');

    const plot = $('status-plot');
    plot.classList.toggle('hidden', !cfg.history);
    if (cfg.history) {
      const ctx = plot.getContext('2d'), w = plot.width, h = plot.height;
      ctx.clearRect(0, 0, w, h);
      const scaleMax = Math.max(st.budget * 2.5, 20);
      const yBudget = h - (st.budget / scaleMax) * h;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, yBudget); ctx.lineTo(w, yBudget); ctx.stroke();
      ctx.setLineDash([]);
      const n = ft.length, bw = w / Math.max(n, 1);
      ft.forEach((v, i) => {
        const bh = Math.min(v / scaleMax, 1) * h;
        ctx.fillStyle = v > st.budget * 1.5 ? '#ff5b6b' : v > st.budget * 1.05 ? '#ffc04d' : '#4dff9d';
        ctx.fillRect(i * bw, h - bh, Math.max(bw - 0.5, 0.5), bh);
      });
    }
  }

  // ---------------- init ----------------
  function init(opts) {
    renderTab('camera', 0);

    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => selectTab(b.dataset.tab));
      b.addEventListener('mouseenter', () => Game.Audio.uiHover());
    });
    $('settings-close').addEventListener('click', closeSettings);
    $('settings-done').addEventListener('click', closeSettings);
    $('menu-btn').addEventListener('click', openSettings);
    $('cam-indicator').addEventListener('click', () => opts.onToggleCam());
    $('peek-btn').addEventListener('click', () => $('settings-modal').classList.toggle('peek'));
    $('restore-defaults').addEventListener('click', () => {
      S.restoreDefaults();
      renderTab(currentTab, 0, true);
      toast('Settings restored to defaults');
    });
    window.addEventListener('resize', moveUnderline);
    window.addEventListener('gamepadconnected', e => { toast('Controller connected'); if (isMenuOpen() && currentTab === 'controls') renderTab('controls', 0, true); });
    window.addEventListener('gamepaddisconnected', () => { toast('Controller disconnected'); if (isMenuOpen() && currentTab === 'controls') renderTab('controls', 0, true); });

    window.addEventListener('keydown', e => {
      if (e.code === 'Escape' && isMenuOpen() && !Game.Input.isRebinding()) { e.preventDefault(); closeSettings(); }
    });

    opts.canvas.addEventListener('click', () => {
      Game.Audio.unlock();
      if (!isMenuOpen() && !isMainMenuOpen() && $('end-screen').classList.contains('hidden')) Game.Input.requestPointerLock();
    });
    $('leave-match').addEventListener('click', () => { closeSettings(); Game.Input.exitPointerLock(); if (opts.onLeave) opts.onLeave(); });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === opts.canvas;
      $('pointerlock-hint').classList.toggle('locked', locked);
      wasLocked = locked;
    });
  }

  // ---------------- main menu, match info, end screen ----------------
  const isMainMenuOpen = () => !$('main-menu').classList.contains('hidden');
  let menuBound = false, menuOpts = null;

  function renderMenuState() {
    const m = S.get('menu');
    document.querySelectorAll('.mm-card').forEach(c => c.classList.toggle('active', c.dataset.mode === m.mode));
    const matchMode = m.mode === '1v1' || m.mode === '2v2' || m.mode === '3v3';
    $('mm-opponent-section').classList.toggle('collapsed', !matchMode);
    $('mm-freeplay-section').classList.toggle('collapsed', m.mode !== 'freeplay');
    // Only bots that play the chosen match mode are listed; keep a valid one selected
    const opps = [...document.querySelectorAll('#mm-opponents .mm-opp')];
    opps.forEach(o => { o.hidden = matchMode && !o.dataset.modes.split(' ').includes(m.mode); });
    const shown = opps.filter(o => !o.hidden);
    if (matchMode && shown.length && !shown.some(o => o.dataset.id === m.opponent)) S.set('menu', 'opponent', shown[0].dataset.id);
    opps.forEach(o => o.classList.toggle('active', o.dataset.id === S.get('menu').opponent));
    document.querySelectorAll('#mm-freeplay-bots .mm-opp').forEach(o => o.classList.toggle('active', o.dataset.id === m.freeplayBot));
    $('mm-mirror-axis').classList.toggle('hidden', m.freeplayBot !== 'mirror');
    document.querySelectorAll('#mm-mirror-axis button').forEach(b => b.classList.toggle('active', b.dataset.axis === m.mirrorAxis));
    const style = S.get('graphics').boostStyle;
    document.querySelectorAll('#mm-boost button').forEach(b => b.classList.toggle('active', b.dataset.boost === style));
  }

  function showMainMenu(opts) {
    menuOpts = opts;
    if (!menuBound) {
      menuBound = true;
      const addBot = (list, o, settingKey) => {
        const b = el('button', 'mm-opp');
        b.dataset.id = o.id;
        b.dataset.modes = (o.modes || []).join(' ');
        const av = el('div', 'mm-opp-avatar ' + o.id, o.name[0]);
        const text = el('div');
        text.append(el('div', 'mm-opp-name', o.name), el('div', 'mm-opp-desc', o.desc));
        b.append(av, text);
        b.addEventListener('click', () => { S.set('menu', settingKey, o.id); renderMenuState(); Game.Audio.uiSelect(); });
        b.addEventListener('mouseenter', () => Game.Audio.uiHover());
        list.appendChild(b);
      };
      opts.opponents.filter(o => o.modes.some(md => md !== 'freeplay')).forEach(o => addBot($('mm-opponents'), o, 'opponent'));
      addBot($('mm-freeplay-bots'), { id: 'none', name: 'No bot', desc: 'Just you and the ball.' }, 'freeplayBot');
      opts.opponents.filter(o => o.modes.includes('freeplay')).forEach(o => addBot($('mm-freeplay-bots'), o, 'freeplayBot'));
      document.querySelectorAll('#mm-mirror-axis button').forEach(b => b.addEventListener('click', () => {
        S.set('menu', 'mirrorAxis', b.dataset.axis); renderMenuState(); Game.Audio.uiSelect();
      }));
      document.querySelectorAll('.mm-card').forEach(c => {
        c.addEventListener('click', () => { S.set('menu', 'mode', c.dataset.mode); renderMenuState(); Game.Audio.uiSelect(); });
        c.addEventListener('mouseenter', () => Game.Audio.uiHover());
      });
      document.querySelectorAll('#mm-boost button').forEach(b => b.addEventListener('click', () => {
        S.set('graphics', 'boostStyle', b.dataset.boost); renderMenuState(); Game.Audio.uiSelect();
      }));
      $('mm-settings').addEventListener('click', () => openSettings());
      $('mm-garage').addEventListener('click', () => { openGarage(); Game.Audio.uiSelect(); });
      $('garage-close').addEventListener('click', closeGarage);
      $('garage-done').addEventListener('click', closeGarage);
      $('garage-modal').addEventListener('click', e => { if (e.target === $('garage-modal')) closeGarage(); });
      document.addEventListener('keydown', e => { if (e.code === 'Escape' && isGarageOpen()) { e.preventDefault(); closeGarage(); } });
      $('mm-play').addEventListener('click', () => {
        Game.Audio.unlock();
        const m = S.get('menu');
        menuOpts.onStart(m.mode, m.mode === 'freeplay' ? m.freeplayBot : m.opponent);
      });
    }
    renderMenuState();
    $('main-menu').classList.remove('hidden');
    $('hud').classList.add('in-menu');
  }

  function hideMainMenu() {
    $('main-menu').classList.add('hidden');
    $('hud').classList.remove('in-menu');
  }

  function setMatchInfo(info) {
    $('label-blue').textContent = info.blueName;
    $('label-orange').textContent = info.orangeName;
    $('mode-label').textContent = info.modeLabel;
  }

  function showEnd(opts) {
    $('end-title').textContent = opts.title;
    $('end-title').className = 'end-title ' + (opts.win ? 'win' : 'lose');
    $('end-blue').textContent = opts.blue;
    $('end-orange').textContent = opts.orange;
    $('end-sub').textContent = opts.sub || '';
    const again = $('end-again'), menu = $('end-menu');
    again.onclick = () => { hideEnd(); opts.onAgain(); };
    menu.onclick = () => { hideEnd(); opts.onMenu(); };
    $('end-screen').classList.remove('hidden');
    Game.Input.exitPointerLock();
  }
  function hideEnd() { $('end-screen').classList.add('hidden'); }

  function hideLoading() {
    const l = $('loading-screen');
    l.style.opacity = '0';
    setTimeout(() => { l.classList.add('hidden'); $('hud').classList.remove('hidden'); }, 500);
  }

  return {
    init, hideLoading, isMenuOpen, openSettings, closeSettings, menuUpdate,
    updateHud, setCam, setScore, showGoal, hideGoal, showReplay, setReplayProgress, countdown, toast, fadeHint, drawStatus,
    setFlip, setSupersonic,
    showMainMenu, hideMainMenu, isMainMenuOpen, setMatchInfo, showEnd, hideEnd
  };
})();
