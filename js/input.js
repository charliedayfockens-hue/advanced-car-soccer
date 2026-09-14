// Keyboard / mouse / gamepad input. Every action can hold several keyboard and controller
// bindings; sticks drive steer/pitch through configurable stick roles, with dead zone and trigger
// threshold. Produces RocketSim CarControls plus camera look and menu navigation input.
window.Game = window.Game || {};

Game.Input = (function () {
  const S = () => Game.Settings.get('controls');

  const keysDown = new Set();
  const mouseDown = new Set();
  let prevDown = {}, currDown = {}, currValue = {};
  let prevButtons = [], currButtons = [];
  let pointerLocked = false, canvasEl = null;
  let mouseDX = 0, mouseDY = 0;
  let rebind = null; // { id, device: 'keys' | 'pad', slot, cb, armed }
  let pad = null;

  // ---------- gamepads ----------
  function connectedPads() {
    const list = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    return list.filter(p => p && p.connected);
  }

  function pollPad() {
    const pads = connectedPads();
    const dev = S().device;
    pad = null;
    if (dev !== 'auto') pad = pads.find(p => String(p.index) === dev) || null;
    if (!pad) pad = pads.find(p => p.mapping === 'standard') || pads[0] || null;
    return pad;
  }

  function padLayout(p) {
    p = p || pad;
    if (!p) return 'xbox';
    return /054c|dualsense|dualshock|playstation|wireless controller/i.test(p.id) ? 'playstation' : 'xbox';
  }

  const BUTTON_NAMES = {
    playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'PS', 'Touchpad'],
    xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide']
  };
  const AXIS_NAMES = [['L Stick Left', 'L Stick Right'], ['L Stick Up', 'L Stick Down'], ['R Stick Left', 'R Stick Right'], ['R Stick Up', 'R Stick Down']];

  function padInputName(g, layout) {
    if (g.type === 'button') return BUTTON_NAMES[layout || padLayout()][g.index] || 'Button ' + g.index;
    const n = AXIS_NAMES[g.index];
    return n ? n[g.sign < 0 ? 0 : 1] : 'Axis ' + g.index + (g.sign < 0 ? '−' : '+');
  }
  function axisName(i) { return ['L Stick X', 'L Stick Y', 'R Stick X', 'R Stick Y'][i] || 'Axis ' + i; }

  function stickAxis(i) {
    if (!pad) return 0;
    const raw = pad.axes[i] || 0, dz = S().deadzone;
    const a = Math.abs(raw);
    return a > dz ? Math.sign(raw) * (a - dz) / (1 - dz) : 0;
  }

  function padBindingValue(g) {
    if (!pad) return 0;
    if (g.type === 'button') {
      const b = pad.buttons[g.index];
      if (!b) return 0;
      const v = Math.max(b.value, b.pressed ? 1 : 0);
      return v > S().triggerThreshold ? v : 0;
    }
    return Math.max(0, stickAxis(g.index) * g.sign);
  }

  // ---------- keyboard / mouse ----------
  function keyHeld(code) {
    if (!code) return false;
    if (code.startsWith('Mouse')) return mouseDown.has(parseInt(code.slice(5), 10));
    return keysDown.has(code);
  }
  function keyValue(id) {
    const b = S().bindings[id];
    return b && b.keys.some(keyHeld) ? 1 : 0;
  }

  function applyRebindKey(code) {
    const b = S().bindings[rebind.id];
    if (rebind.slot >= 0 && rebind.slot < b.keys.length) b.keys[rebind.slot] = code;
    else if (!b.keys.includes(code)) b.keys.push(code);
    finishRebind(true);
  }

  function onKeyDown(e) {
    if (rebind) {
      e.preventDefault();
      if (e.code === 'Escape') return finishRebind(false);
      if (rebind.device === 'keys') applyRebindKey(e.code);
      return;
    }
    keysDown.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace'].includes(e.code) && e.target === document.body) e.preventDefault();
  }
  function onKeyUp(e) { keysDown.delete(e.code); }

  function onMouseDown(e) {
    if (rebind) {
      if (rebind.device === 'keys' && rebind.armed) {
        e.preventDefault();
        applyRebindKey('Mouse' + e.button);
      }
      return;
    }
    if (pointerLocked || e.target === canvasEl) mouseDown.add(e.button);
  }
  function onMouseUp(e) {
    mouseDown.delete(e.button);
    if (rebind) rebind.armed = true;
  }
  function onMouseMove(e) {
    if (!pointerLocked) return;
    mouseDX += e.movementX || 0;
    mouseDY += e.movementY || 0;
  }

  // ---------- rebinding ----------
  function finishRebind(ok) {
    const cb = rebind && rebind.cb;
    rebind = null;
    if (ok) Game.Settings.touch('controls');
    if (cb) cb(ok);
  }

  function padAnyActive() {
    if (!pad) return false;
    return pad.buttons.some(b => b.pressed || b.value > 0.3) || pad.axes.some(a => Math.abs(a) > 0.4);
  }

  function checkPadRebind() {
    if (!rebind || rebind.device !== 'pad' || !pad) return;
    if (!rebind.armed) { rebind.armed = !padAnyActive(); return; }
    let g = null;
    pad.buttons.forEach((b, i) => { if (!g && (b.pressed || b.value > 0.6)) g = { type: 'button', index: i }; });
    pad.axes.forEach((a, i) => { if (!g && Math.abs(a) > 0.7) g = { type: 'axis', index: i, sign: Math.sign(a) }; });
    if (!g) return;
    const list = S().bindings[rebind.id].pad;
    const same = x => x.type === g.type && x.index === g.index && (x.type === 'button' || x.sign === g.sign);
    if (rebind.slot >= 0 && rebind.slot < list.length) list[rebind.slot] = g;
    else if (!list.some(same)) list.push(g);
    finishRebind(true);
  }

  // ---------- frame update ----------
  function updateFrame() {
    pollPad();
    checkPadRebind();
    prevButtons = currButtons;
    currButtons = pad ? pad.buttons.map(b => b.pressed || b.value > 0.5) : [];

    const bindings = S().bindings;
    Game.Actions.forEach(a => {
      const b = bindings[a.id];
      let v = b.keys.some(keyHeld) ? 1 : 0;
      b.pad.forEach(g => { v = Math.max(v, padBindingValue(g)); });
      if (rebind) v = 0;
      prevDown[a.id] = !!currDown[a.id];
      currDown[a.id] = v > 0;
      currValue[a.id] = Math.min(v, 1);
    });
  }

  function endFrame() { mouseDX = 0; mouseDY = 0; }

  const isDown = id => !!currDown[id];
  const wasPressed = id => !!currDown[id] && !prevDown[id];
  const value = id => currValue[id] || 0;
  const clamp1 = v => Math.max(-1, Math.min(1, v));

  function buildControls() {
    const c = S();
    let stickSteer = 0, stickPitch = 0;
    if (pad && !rebind) {
      stickSteer = stickAxis(c.steerAxis) * (c.invertSteer ? -1 : 1);
      stickPitch = stickAxis(c.pitchAxis) * (c.invertPitch ? -1 : 1);
    }
    const steer = clamp1(value('steerRight') - value('steerLeft') + stickSteer);
    const freeRoll = isDown('freeAirRoll');
    const directionalRoll = value('airRollRight') - value('airRollLeft');
    return {
      throttle: clamp1(value('throttle') - value('reverse')),
      steer,
      pitch: clamp1(keyValue('reverse') - keyValue('throttle') + stickPitch),
      yaw: freeRoll ? 0 : steer,
      roll: clamp1(directionalRoll + (freeRoll ? steer : 0)),
      jump: isDown('jump'),
      boost: isDown('boost'),
      handbrake: isDown('powerslide')
    };
  }

  function look() {
    return { x: value('lookRight') - value('lookLeft'), y: value('lookUp') - value('lookDown') };
  }

  function keyName(code) {
    if (!code) return '—';
    const mouse = { Mouse0: 'L Mouse', Mouse1: 'M Mouse', Mouse2: 'R Mouse', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
    if (mouse[code]) return mouse[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    const map = { ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
    return map[code] || code;
  }

  function init(canvas) {
    canvasEl = canvas;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', () => { keysDown.clear(); mouseDown.clear(); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === canvas; });
  }

  function requestPointerLock() {
    if (!canvasEl || !canvasEl.requestPointerLock) return;
    try {
      const p = canvasEl.requestPointerLock();
      if (p && p.catch) p.catch(() => { /* not allowed here */ });
    } catch (e) { /* not allowed here */ }
  }
  function exitPointerLock() { if (document.exitPointerLock && document.pointerLockElement) document.exitPointerLock(); }

  return {
    init, updateFrame, endFrame, isDown, wasPressed, value, buildControls, look,
    startRebind(id, device, slot, cb) { rebind = { id, device, slot, cb, armed: device === 'keys' ? mouseDown.size === 0 : false }; },
    cancelRebind() { if (rebind) finishRebind(false); },
    isRebinding: () => !!rebind,
    removeBinding(id, device, slot) {
      S().bindings[id][device].splice(slot, 1);
      Game.Settings.touch('controls');
    },
    padButtonPressed: i => !!currButtons[i] && !prevButtons[i],
    padButtonDown: i => !!currButtons[i],
    stickAxis,
    connectedPads, padLayout, padInputName, axisName, keyName, requestPointerLock, exitPointerLock,
    get pad() { return pad; },
    get pointerLocked() { return pointerLocked; },
    get mouseDX() { return mouseDX; },
    get mouseDY() { return mouseDY; }
  };
})();
