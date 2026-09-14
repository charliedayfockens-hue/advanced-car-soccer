// Physics constants ported verbatim from RocketSim (https://github.com/ZealanL/RocketSim,
// MIT License, Copyright (c) ZealanL): src/RLConst.h and src/Sim/Car/CarConfig/CarConfig.cpp.
// Like RocketSim, the simulation runs in Bullet units (1 BT = 50 uu) and converts at the use site.
window.Game = window.Game || {};

// RocketSim's LinearPieceCurve::GetOutput (clamped at both ends, defaultOutput when empty).
Game.Curve = function (points, defaultOutput) {
  const def = defaultOutput === undefined ? 1 : defaultOutput;
  return function (x) {
    if (points.length === 0) return def;
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (points[i][0] > x) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
      }
    }
    return points[points.length - 1][1];
  };
};

Game.RL = {
  BT_TO_UU: 50,
  UU_TO_BT: 1 / 50,
  TICK_RATE: 120,

  GRAVITY_Z: -650,

  ARENA_COLLISION_BASE_FRICTION: 0.6,
  ARENA_COLLISION_BASE_RESTITUTION: 0.3,

  CAR_MASS_BT: 180,
  BALL_MASS_BT: 180 / 6,

  CAR_COLLISION_FRICTION: 0.3,
  CAR_COLLISION_RESTITUTION: 0.1,
  CARBALL_COLLISION_FRICTION: 2.0,
  CARBALL_COLLISION_RESTITUTION: 0.0,
  CARWORLD_COLLISION_FRICTION: 0.3,
  CARWORLD_COLLISION_RESTITUTION: 0.3,

  BALL_REST_Z: 93.15,
  BALL_MAX_ANG_SPEED: 6,
  BALL_DRAG: 0.03,
  BALL_FRICTION: 0.35,
  BALL_RESTITUTION: 0.6,
  BALL_COLLISION_RADIUS_SOCCAR: 91.25,

  CAR_MAX_SPEED: 2300,
  BALL_MAX_SPEED: 6000,

  BOOST_MAX: 100,
  BOOST_MIN_TIME: 0.1,
  BOOST_ACCEL_GROUND: 2975 / 3,
  BOOST_ACCEL_AIR: 3175 / 3,

  CAR_MAX_ANG_SPEED: 5.5,

  SUPERSONIC_START_SPEED: 2200,
  SUPERSONIC_MAINTAIN_MIN_SPEED: 2200 - 100,
  SUPERSONIC_MAINTAIN_MAX_TIME: 1,

  POWERSLIDE_RISE_RATE: 5,
  POWERSLIDE_FALL_RATE: 2,

  THROTTLE_TORQUE_AMOUNT: 180 * 400,
  BRAKE_TORQUE_AMOUNT: 180 * (14.25 + 1 / 3),

  STOPPING_FORWARD_VEL: 25,
  COASTING_BRAKE_FACTOR: 0.15,
  BRAKING_NO_THROTTLE_SPEED_THRESH: 0.01,
  THROTTLE_DEADZONE: 0.001,

  THROTTLE_AIR_ACCEL: 200 / 3,

  JUMP_ACCEL: 4375 / 3,
  JUMP_IMMEDIATE_FORCE: 875 / 3,
  JUMP_MIN_TIME: 0.025,
  JUMP_RESET_TIME_PAD: 1 / 40,
  JUMP_MAX_TIME: 0.2,
  JUMP_PRE_MIN_ACCEL_SCALE: 0.62,
  DOUBLEJUMP_MAX_DELAY: 1.25,

  FLIP_Z_DAMP_120: 0.35,
  FLIP_Z_DAMP_START: 0.15,
  FLIP_Z_DAMP_END: 0.21,
  FLIP_TORQUE_TIME: 0.65,
  FLIP_TORQUE_MIN_TIME: 0.41,
  FLIP_PITCHLOCK_TIME: 1,
  FLIP_PITCHLOCK_EXTRA_TIME: 0.3,
  FLIP_INITIAL_VEL_SCALE: 500,
  FLIP_TORQUE_X: 260,
  FLIP_TORQUE_Y: 224,
  FLIP_FORWARD_IMPULSE_MAX_SPEED_SCALE: 1,
  FLIP_SIDE_IMPULSE_MAX_SPEED_SCALE: 1.9,
  FLIP_BACKWARD_IMPULSE_MAX_SPEED_SCALE: 2.5,
  FLIP_BACKWARD_IMPULSE_SCALE_X: 16 / 15,

  SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y: 5124.25,

  CAR_TORQUE_SCALE: 2 * Math.PI / (1 << 16) * 1000,

  CAR_AUTOFLIP_IMPULSE: 200,
  CAR_AUTOFLIP_TORQUE: 50,
  CAR_AUTOFLIP_TIME: 0.4,
  CAR_AUTOFLIP_NORMZ_THRESH: Math.SQRT1_2,
  CAR_AUTOFLIP_ROLL_THRESH: 2.8,

  CAR_AUTOROLL_FORCE: 100,
  CAR_AUTOROLL_TORQUE: 80,

  BALL_CAR_EXTRA_IMPULSE_Z_SCALE: 0.35,
  BALL_CAR_EXTRA_IMPULSE_FORWARD_SCALE: 0.65,
  BALL_CAR_EXTRA_IMPULSE_MAXDELTAVEL_UU: 4600,

  CAR_SPAWN_REST_Z: 17,
  CAR_RESPAWN_Z: 36,

  CARCAR_COLLISION_FRICTION: 0.09,
  CARCAR_COLLISION_RESTITUTION: 0.1,
  BUMP_COOLDOWN_TIME: 0.25,
  BUMP_MIN_FORWARD_DIST: 64.5,
  DEMO_RESPAWN_TIME: 3,

  // Blue team respawn spots after a demo (x, y, yaw); orange mirrored
  CAR_RESPAWN_LOCATIONS_SOCCAR: [
    { x: -2304, y: -4608, yaw: Math.PI / 2 },
    { x: -2688, y: -4608, yaw: Math.PI / 2 },
    { x: 2304, y: -4608, yaw: Math.PI / 2 },
    { x: 2688, y: -4608, yaw: Math.PI / 2 }
  ],

  // Angle order is PYR
  CAR_AIR_CONTROL_TORQUE: { pitch: 130, yaw: 95, roll: 400 },
  CAR_AIR_CONTROL_DAMPING: { pitch: 30, yaw: 20, roll: 50 },

  BTVehicle: {
    SUSPENSION_FORCE_SCALE_FRONT: 36 - 1 / 4,
    SUSPENSION_FORCE_SCALE_BACK: 54 + 1 / 4 + 1.5 / 100,
    SUSPENSION_STIFFNESS: 500,
    WHEELS_DAMPING_COMPRESSION: 25,
    WHEELS_DAMPING_RELAXATION: 40,
    MAX_SUSPENSION_TRAVEL: 12,
    SUSPENSION_SUBTRACTION: 0.05
  },

  // Blue team kickoff spawns (x, y, yaw); orange is mirrored.
  CAR_SPAWN_LOCATIONS_SOCCAR: [
    { x: -2048, y: -2560, yaw: Math.PI / 4 * 1 },
    { x: 2048, y: -2560, yaw: Math.PI / 4 * 3 },
    { x: -256, y: -3840, yaw: Math.PI / 4 * 2 },
    { x: 256, y: -3840, yaw: Math.PI / 4 * 2 },
    { x: 0, y: -4608, yaw: Math.PI / 4 * 2 }
  ]
};

Object.assign(Game.RL, {
  STEER_ANGLE_FROM_SPEED_CURVE: Game.Curve([[0, 0.53356], [500, 0.31930], [1000, 0.18203], [1500, 0.10570], [1750, 0.08507], [3000, 0.03454]]),
  POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE: Game.Curve([[0, 0.39235], [2500, 0.12610]]),
  DRIVE_SPEED_TORQUE_FACTOR_CURVE: Game.Curve([[0, 1.0], [1400, 0.1], [1410, 0.0]]),
  NON_STICKY_FRICTION_FACTOR_CURVE: Game.Curve([[0, 0.1], [0.7075, 0.5], [1, 1.0]]),
  LAT_FRICTION_CURVE: Game.Curve([[0, 1.0], [1, 0.2]]),
  LONG_FRICTION_CURVE: Game.Curve([]),
  HANDBRAKE_LAT_FRICTION_FACTOR_CURVE: Game.Curve([[0, 0.1]]),
  HANDBRAKE_LONG_FRICTION_FACTOR_CURVE: Game.Curve([[0, 0.5], [1, 0.9]]),
  BALL_CAR_EXTRA_IMPULSE_FACTOR_CURVE: Game.Curve([[0, 0.65], [500, 0.65], [2300, 0.55], [4600, 0.30]]),
  BUMP_VEL_AMOUNT_GROUND_CURVE: Game.Curve([[0, 5 / 6], [1400, 1100], [2200, 1530]]),
  BUMP_VEL_AMOUNT_AIR_CURVE: Game.Curve([[0, 5 / 6], [1400, 1390], [2200, 1945]]),
  BUMP_UPWARD_VEL_AMOUNT_CURVE: Game.Curve([[0, 2 / 6], [1400, 278], [2200, 417]])
});

// Octane (CarConfig.cpp index 0), all in uu.
Game.CarConfigOctane = {
  hitboxSize: [120.507, 86.6994, 38.6591],
  hitboxPosOffset: [13.8757, 0, 20.755],
  frontWheels: { wheelRadius: 12.50, suspensionRestLength: 38.755, connectionPointOffset: [51.25, 25.90, 20.755] },
  backWheels: { wheelRadius: 15.00, suspensionRestLength: 37.055, connectionPointOffset: [-33.75, 29.50, 20.755] },
  dodgeDeadzone: 0.5
};

// Soccar arena shape (uu). The real game's collision mesh isn't redistributable, so the arena
// collision is an analytic surface built to these published dimensions (RLBot "useful game values").
Game.ArenaGeom = {
  extentX: 4096,
  extentY: 5120,
  height: 2048,
  cornerPlane: 8064,       // corner walls: |x| + |y| = 8064
  goalHalfWidth: 892.755,
  goalHeight: 642.775,
  goalDepth: 880,
  floorRampRadius: 256,    // floor -> wall curve
  ceilingRampRadius: 256,  // wall -> ceiling curve
  cornerRoundRadius: 300,  // vertical rounding where side/back walls meet the corner walls
  goalEdgeRadius: 40,      // rounding on the posts and crossbar
  goalCornerRadius: 120,   // rounding on every inner edge of the goal box
  // Ball-vs-arena surface offset. Bullet keeps contacts up to ~3.16uu apart (sphere contact
  // breaking threshold), so a settling ball comes to rest that far out; -1.25 makes it rest at
  // BALL_REST_Z (93.15) like the real game.
  ballWorldMargin: -1.25
};

// Big and small boost pad locations (RLConst::BoostPads), uu
Game.BoostPads = {
  CYL_HEIGHT: 95, CYL_RAD_BIG: 208, CYL_RAD_SMALL: 144,
  BOX_HEIGHT: 64, BOX_RAD_BIG: 160, BOX_RAD_SMALL: 120,
  COOLDOWN_BIG: 10, COOLDOWN_SMALL: 4,
  BOOST_AMOUNT_BIG: 100, BOOST_AMOUNT_SMALL: 12,
  BOOST_USED_PER_SECOND: 100 / 3,
  BIG: [[-3584, 0, 73], [3584, 0, 73], [-3072, 4096, 73], [3072, 4096, 73], [-3072, -4096, 73], [3072, -4096, 73]],
  SMALL: [[0, -4240, 70], [-1792, -4184, 70], [1792, -4184, 70], [-940, -3308, 70], [940, -3308, 70], [0, -2816, 70],
    [-3584, -2484, 70], [3584, -2484, 70], [-1788, -2300, 70], [1788, -2300, 70], [-2048, -1036, 70], [0, -1024, 70],
    [2048, -1036, 70], [-1024, 0, 70], [1024, 0, 70], [-2048, 1036, 70], [0, 1024, 70], [2048, 1036, 70],
    [-1788, 2300, 70], [1788, 2300, 70], [-3584, 2484, 70], [3584, 2484, 70], [0, 2816, 70], [-940, 3308, 70],
    [940, 3308, 70], [-1792, 4184, 70], [1792, 4184, 70], [0, 4240, 70]]
};

// Rebindable actions, grouped as in the Controls tab.
Game.Actions = [
  { id: 'throttle', label: 'Throttle', desc: 'Drive forward. On keyboard it also pitches the nose down in the air.', group: 'Driving', hint: 'pitch: stick role' },
  { id: 'reverse', label: 'Reverse', desc: 'Brake and drive backward. On keyboard it also pitches the nose up in the air.', group: 'Driving', hint: 'pitch: stick role' },
  { id: 'steerLeft', label: 'Steer Left', desc: 'Steers left; yaws in the air unless an air roll is held.', group: 'Driving', hint: 'steer: stick role' },
  { id: 'steerRight', label: 'Steer Right', desc: 'Steers right; yaws in the air unless an air roll is held.', group: 'Driving', hint: 'steer: stick role' },
  { id: 'boost', label: 'Boost', desc: 'Burn boost for thrust.', group: 'Driving' },
  { id: 'jump', label: 'Jump', desc: 'Jump, double jump and dodge.', group: 'Driving' },
  { id: 'powerslide', label: 'Powerslide', desc: 'Slide on the ground. Use Free Air Roll to roll in the air.', group: 'Driving' },

  { id: 'freeAirRoll', label: 'Free Air Roll', desc: 'Hold so steering rolls the car in the air instead of yawing.', group: 'Aerial', hint: 'held: steer input rolls' },
  { id: 'airRollLeft', label: 'Air Roll Left', desc: 'Roll left. Analog triggers and sticks give partial roll.', group: 'Aerial', hint: 'analog pull sets roll speed' },
  { id: 'airRollRight', label: 'Air Roll Right', desc: 'Roll right. Analog triggers and sticks give partial roll.', group: 'Aerial', hint: 'analog pull sets roll speed' },

  { id: 'ballCam', label: 'Ball Cam', desc: 'Switch between ball cam and car cam.', group: 'Camera' },
  { id: 'lookLeft', label: 'Look Left', desc: 'Look left while held.', group: 'Camera' },
  { id: 'lookRight', label: 'Look Right', desc: 'Look right while held.', group: 'Camera' },
  { id: 'lookUp', label: 'Look Up', desc: 'Look up while held.', group: 'Camera' },
  { id: 'lookDown', label: 'Look Down', desc: 'Look down while held.', group: 'Camera' },

  { id: 'takePossession', label: 'Take Possession', desc: 'Put the ball in front of the car, moving with it.', group: 'Ball Control' },
  { id: 'startDribble', label: 'Start Dribble', desc: 'Put the ball on the roof, moving with the car.', group: 'Ball Control' },
  { id: 'passBall', label: 'Pass Ball', desc: 'Send the ball toward the car from where it is.', group: 'Ball Control' },
  { id: 'launchBall', label: 'Launch Ball', desc: 'Pop the ball straight up from where it is.', group: 'Ball Control' },

  { id: 'resetShot', label: 'Reset Shot', desc: 'Send the car and ball back to kickoff.', group: 'Session' },
  { id: 'menu', label: 'Menu / Cursor', desc: 'Keyboard: free the cursor or go back to playing. Controller: open settings.', group: 'Session' }
];
