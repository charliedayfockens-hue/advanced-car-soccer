// Persistent settings store: Camera, Controls, Graphics, Audio, Training and Status groups.
// Anything can subscribe with Game.Settings.on(group, fn) to react to changes immediately.
window.Game = window.Game || {};

Game.Settings = (function () {
  const STORAGE_KEY = 'carBall.settings.v1';

  // Bindings: { keys: [...codes], pad: [...{type:'button',index} | {type:'axis',index,sign}] }
  const B = (keys, pad) => ({ keys, pad });
  const btn = i => ({ type: 'button', index: i });
  const axis = (i, sign) => ({ type: 'axis', index: i, sign });

  const DEFAULT_BINDINGS = {
    throttle: B(['KeyW'], [btn(7)]),
    reverse: B(['KeyS'], [axis(1, 1)]),
    steerLeft: B(['KeyA'], []),
    steerRight: B(['KeyD'], []),
    boost: B(['Mouse0'], [btn(5)]),
    jump: B(['Mouse2'], [btn(2)]),
    powerslide: B(['ShiftLeft', 'ShiftRight'], [btn(6)]),
    freeAirRoll: B(['ShiftLeft', 'ShiftRight'], [btn(6)]),
    airRollLeft: B(['KeyQ'], [btn(0)]),
    airRollRight: B(['KeyE'], []),
    ballCam: B(['Space'], [btn(3)]),
    lookLeft: B([], [axis(2, -1)]),
    lookRight: B([], [axis(2, 1)]),
    lookUp: B([], [axis(3, -1)]),
    lookDown: B([], [axis(3, 1)]),
    takePossession: B(['Digit1'], [btn(13)]),
    startDribble: B(['Digit2'], [btn(12)]),
    passBall: B(['Digit3'], [btn(14)]),
    launchBall: B(['Digit4'], [btn(15)]),
    resetShot: B(['Backspace'], [btn(11), btn(8)]),
    menu: B(['Escape'], [btn(9)])
  };

  const DEFAULTS = {
    camera: { fov: 110, distance: 270, height: 100, angle: -3, stiffness: 0.35, swivelSpeed: 4, transitionSpeed: 1, cameraShake: false, invertSwivel: true },
    controls: { device: 'auto', deadzone: 0.12, steerAxis: 0, invertSteer: false, pitchAxis: 1, invertPitch: false, triggerThreshold: 0.15, bindings: DEFAULT_BINDINGS },
    graphics: { theme: 'realistic', limitFps: false, maxFps: 120, showStadium: true, boostStyle: 'alpha' },
    menu: { mode: 'freeplay', opponent: 'element', freeplayBot: 'none', mirrorAxis: 'midfield' },
    garage: { car: 'surbabu', explosion: 'classic', explosionPaints: {} },
    profile: { name: '' },
    audio: { volume: 60 },
    training: { disableGoalReset: false, boost: 'unlimited', showHitbox: false },
    status: { show: false, frameTime: true, history: true, breakdown: true, simulation: true, renderer: false }
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const listeners = {};
  let data = clone(DEFAULTS);

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      Object.keys(DEFAULTS).forEach(group => {
        if (!saved[group]) return;
        Object.keys(DEFAULTS[group]).forEach(k => {
          if (saved[group][k] === undefined) return;
          if (k === 'bindings') {
            Object.keys(DEFAULT_BINDINGS).forEach(id => { if (saved[group].bindings[id]) data.controls.bindings[id] = saved[group].bindings[id]; });
          } else {
            data[group][k] = saved[group][k];
          }
        });
      });
    } catch (e) { /* corrupt or blocked storage */ }
  }

  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ } }

  function emit(group) { (listeners[group] || []).forEach(fn => fn(data[group])); }

  load();

  return {
    get data() { return data; },
    get(group) { return data[group]; },
    set(group, key, value) {
      data[group][key] = value;
      save();
      emit(group);
    },
    touch(group) { save(); emit(group); },
    on(group, fn) { (listeners[group] = listeners[group] || []).push(fn); fn(data[group]); },
    restoreDefaults() {
      data = clone(DEFAULTS);
      save();
      Object.keys(DEFAULTS).forEach(emit);
    },
    defaults: DEFAULTS
  };
})();
