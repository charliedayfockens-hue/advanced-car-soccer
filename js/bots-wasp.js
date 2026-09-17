// Wasp: Bumblebee's hivemind team play driven by Nexto's mind.
// One hive per team makes Bumblebee's decisions (bots-botimus.js): who takes the kickoff, who grabs corner boost,
// who stays home, and exactly one car sent for the ball at a time. That car plays with Nexto's network
// (bots-necto.js), so its touches, aerials, 50/50s, speed and aggression are Nexto's. Teammates rotate with
// Bumblebee's scripted positioning, tuned more aggressively: tighter support distance, boosting between spots,
// and an attacker re-picked every 0.3 s so the closest good challenger always goes.
window.Game = window.Game || {};

(function () {
  const B = Game.Botimus, M = B.math;
  const { groundDistance, align, ground, norm, Input } = M;
  const minBy = (arr, f) => arr.reduce((a, b) => (f(b) < f(a) ? b : a));
  const toControls = c => ({
    throttle: +c.throttle || 0, steer: +c.steer || 0, pitch: +c.pitch || 0, yaw: +c.yaw || 0, roll: +c.roll || 0,
    jump: !!c.jump, boost: !!c.boost, handbrake: !!c.handbrake
  });
  const hives = new WeakMap();
  let warned = false;

  class WaspHive {
    constructor(world, team) {
      this.world = world;
      this.team = team;
      this.drones = [];
      this.tick = -1;
      this.attacker = null;
      this.kickoffTaker = null;
      this.kickoffSet = false;
      this.roleTimer = 0;
    }

    add(bot) { this.drones.push(bot); }

    update() {
      const w = this.world;
      if (this.tick === w.tickCount) return;
      this.tick = w.tickCount;
      const info = B.gameInfo(w, this.team);
      this.drones.forEach(d => { d.car = info.cars[d.index]; });
      const alive = this.drones.filter(d => !d.car.demolished);
      if (!alive.length) return;
      if (w.kickoffPause) { this.kickoff(info, alive); return; }
      this.kickoffSet = false;
      this.kickoffTaker = null;
      this.roleTimer -= info.time_delta;
      if (!this.attacker || this.attacker.car.demolished || this.roleTimer <= 0) {
        this.pickAttacker(info, alive);
        this.roleTimer = 0.3;
      }
      alive.forEach(d => { if (d !== this.attacker) this.support(info, d, alive); });
      this.avoidTeamBumps(info);
    }

    // Nexto takes the kickoff with the closest car (the left one on a tie); the others go for boost or hang back
    kickoff(info, alive) {
      const dist = d => groundDistance(d.car, info.ball);
      const closest = Math.min(...alive.map(dist));
      const tied = alive.filter(d => dist(d) - closest < 10);
      this.kickoffTaker = tied.length > 1 ? minBy(tied, d => (this.team === 0 ? d.car.position[0] : -d.car.position[0])) : tied[0];
      this.attacker = this.kickoffTaker;
      if (!this.kickoffSet) {
        this.kickoffSet = true;
        const others = alive.filter(d => d !== this.kickoffTaker);
        const back = others.length ? minBy(others, d => -groundDistance(d.car, info.ball)) : null;
        const reserved = new Set();
        others.forEach(d => {
          if (d === back && others.length > 1) { d.maneuver = new B.DriveBackwardsToGoal(d.car, info); return; }
          const pad = minBy(info.large_boost_pads, p => groundDistance(d.car, p) + (reserved.has(p) ? 1e6 : 0));
          reserved.add(pad);
          d.maneuver = Math.abs(d.car.position[0]) > 2000 ? new B.HalfFlipPickup(d.car, pad) : new B.PickupBoostPad(d.car, pad);
        });
      }
      alive.forEach(d => { if (d !== this.kickoffTaker) this.stepManeuver(info, d); });
    }

    // The fastest well-aligned intercept goes; the current attacker gets a little extra time before it's swapped
    pickAttacker(info, alive) {
      info.predict_ball();
      const theirGoal = ground(info.their_goal.center), myGoal = ground(info.my_goal.center);
      const score = d => {
        const i = new B.Intercept(d.car, info.ball_predictions);
        let s = i.time;
        if (align(d.car.position, i.ball, theirGoal) < 0 && groundDistance(i, myGoal) > 2500) s += 0.6;
        if (d.car.position[2] > 300 && !d.car.on_ground) s += 0.4;
        if (d === this.attacker) s -= 0.25;
        return s;
      };
      const next = minBy(alive, score);
      if (next !== this.attacker) {
        if (this.attacker) this.attacker.maneuver = null;
        next.maneuver = null;
        this.attacker = next;
      }
    }

    // Everyone else: grab boost when low, the last car home defends, the rest support close behind the play
    support(info, d, alive) {
      if (d.maneuver && !d.maneuver.finished) { this.stepManeuver(info, d); return; }
      const car = d.car, myGoal = info.my_goal.center;
      if (!car.on_ground) {
        d.maneuver = new B.Recovery(car);
      } else if (car.boost < 35) {
        const taken = new Set(this.drones.filter(o => o !== d && o.maneuver instanceof B.PickupBoostPad).map(o => o.maneuver.pad));
        const pad = B.choosePad(info, car, taken);
        d.maneuver = pad ? new B.PickupBoostPad(car, pad) : null;
      }
      if (!d.maneuver || d.maneuver.finished) {
        const helpers = alive.filter(o => o !== this.attacker);
        const lastMan = minBy(helpers, o => groundDistance(o.car, myGoal)) === d;
        d.maneuver = new B.GeneralDefense(car, info, info.ball.position, lastMan && helpers.length > 1 ? 4800 : 2200);
        d.maneuver.travel.waste_boost = true;
      }
      this.stepManeuver(info, d);
    }

    stepManeuver(info, d) {
      if (!d.maneuver) return;
      d.maneuver.step(info.time_delta);
      d.scripted = toControls(d.maneuver.controls);
      if (d.maneuver.finished) d.maneuver = null;
    }

    // Supporters hop over the attacker instead of bumping it
    avoidTeamBumps(info) {
      const byIndex = new Map(this.drones.map(d => [d.index, d]));
      for (const [i1, i2] of info.detect_collisions(0.2, 1 / 60)) {
        const a = byIndex.get(i1), b = byIndex.get(i2);
        if (!a || !b) continue;
        const hop = a === this.attacker ? b : a;
        if (hop.scripted && hop.car.on_ground) hop.scripted.jump = true;
      }
    }
  }

  class WaspBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Wasp';
      this.nexto = new Game.BotsNecto.NextoBot(world, carIndex);
      this.maneuver = null;
      this.scripted = toControls(Input());
      const team = world.cars[carIndex].team === 'orange' ? 1 : 0;
      let byTeam = hives.get(world.cars);
      if (!byTeam) hives.set(world.cars, byTeam = {});
      this.hive = byTeam[team] || (byTeam[team] = new WaspHive(world, team));
      this.hive.add(this);
    }

    get ready() { return this.nexto.ready; }

    reset() {
      this.nexto.reset();
      this.maneuver = null;
      this.hive.attacker = null;
      this.hive.kickoffSet = false;
    }

    tick() {
      // Nexto runs on every car every tick so its action timing never breaks when a car becomes the attacker
      const nexto = this.nexto.tick();
      try {
        this.hive.update();
      } catch (e) {
        if (!warned) { warned = true; console.warn('Wasp hive error (plans reset)', e); }
        this.hive.drones.forEach(d => { d.maneuver = null; });
      }
      const leading = this.world.kickoffPause ? this.hive.kickoffTaker === this : this.hive.attacker === this;
      return leading || !this.maneuver ? nexto : this.scripted;
    }
  }

  const list = Game.Bots.OPPONENTS;
  list.splice(list.findIndex(o => o.id === 'bumblebee') + 1, 0,
    { id: 'wasp', name: 'Wasp', desc: "Bumblebee's hivemind with Nexto's mind. One hive runs the team exactly like Bumblebee: kickoff roles, boost runs, one car on the ball and a defender home. The car sent for the ball plays with Nexto's network, with its speed, aerials, 50/50s and aggression, while teammates rotate in tight behind it.",
      modes: ['1v1', '2v2', '3v3'], make: (w, i) => new WaspBot(w, i), load: () => Game.BotsNecto.loadModel('nexto') });

  Game.BotsWasp = { WaspBot };
})();
