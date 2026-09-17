// Opti (1v1 only): this game's version of Kaiyotech's Opti (https://github.com/Kaiyotech/Opti).
// The real Opti is a selector network choosing between separately trained sub-models (kickoff, general play,
// recovery, demo, aerials ...). Its trained models were never published, so this bot keeps the idea with
// sub-models that exist here: a selector switches between Nexto's network (kickoff and general play), a
// recovery controller that lands wheels-down, and a demo sub-model that hunts an exposed opponent.
window.Game = window.Game || {};

Game.BotsOpti = (function () {
  const BT = Game.RL.BT_TO_UU;
  const C = Game.BotControl;

  class OptiBot {
    constructor(world, carIndex) {
      this.world = world;
      this.index = carIndex;
      this.name = 'Opti';
      this.general = new Game.BotsNecto.NextoBot(world, carIndex);
      this.controls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      this.reset();
    }

    get ready() { return this.general.ready; }

    reset() {
      this.general.reset();
      this.option = 'general';
      this.held = 0;
    }

    // The selector: which sub-model should play this tick
    select() {
      const w = this.world, me = w.cars[this.index], s = me.state;
      if (w.kickoffPause) return 'general';
      const pos = me.body.pos.mul(BT), ball = w.ball.pos.mul(BT);
      const ballDist = pos.sub(ball).length();
      const up = me.body.rot.col(2);
      if (!s.isOnGround && pos.z > 80 && ballDist > 900 && (up.z < 0.2 || s.hasDoubleJumped || s.hasFlipped)) return 'recovery';
      const opp = w.cars.filter(c => c.team !== me.team && !c.isDemoed && !c.demoImmune)
        .sort((a, b) => a.body.pos.sub(me.body.pos).length2() - b.body.pos.sub(me.body.pos).length2())[0];
      if (opp && s.isOnGround && s.boost > 35) {
        const op = opp.body.pos.mul(BT), d = op.sub(pos), dist = d.length();
        const f = me.body.rot.col(0);
        const facing = (d.x * f.x + d.y * f.y) / (dist * (Math.hypot(f.x, f.y) || 1));
        const ownGoalY = me.team === 'orange' ? 5120 : -5120;
        if (dist < 1700 && facing > 0.85 && op.z < 200 && op.sub(ball).length() > 900 &&
            Math.abs(ball.y - ownGoalY) > 3500 && ballDist > 1200) return 'demo';
      }
      return 'general';
    }

    tick() {
      if (!this.ready) return this.controls;
      // Nexto keeps its own action timing, so it runs every tick even while another sub-model drives
      const general = this.general.tick();
      this.held -= 1 / 120;
      const choice = this.select();
      if (choice !== this.option && (this.held <= 0 || this.world.kickoffPause)) { this.option = choice; this.held = 0.35; }
      const c = this.controls, me = this.world.cars[this.index];
      if (this.option === 'recovery') {
        C.recover(me, c);
      } else if (this.option === 'demo') {
        const opp = this.world.cars.filter(x => x.team !== me.team && !x.isDemoed && !x.demoImmune)
          .sort((a, b) => a.body.pos.sub(me.body.pos).length2() - b.body.pos.sub(me.body.pos).length2())[0];
        if (!opp) { Object.assign(c, general); return c; }
        const op = opp.body.pos.mul(BT), ov = opp.body.linVel.mul(BT);
        const lead = Math.min(op.sub(me.body.pos.mul(BT)).length() / 2300, 0.4);
        C.steerTo(me, op.x + ov.x * lead, op.y + ov.y * lead, c, { boost: true });
      } else {
        Object.assign(c, general);
      }
      return c;
    }
  }

  const list = Game.Bots.OPPONENTS;
  const after = list.findIndex(o => o.id === 'coconut') >= 0 ? list.findIndex(o => o.id === 'coconut') : list.findIndex(o => o.id === 'nexto');
  list.splice(after + 1, 0,
    { id: 'opti', name: 'Opti', desc: '1v1 only. After Kaiyotech\'s Opti: a selector picks the right sub-model every moment. It plays Nexto\'s network for kickoffs and general play, recovers to land wheels-down, and switches to demo mode when you leave yourself exposed.',
      modes: ['1v1'], make: (w, i) => new OptiBot(w, i), load: () => Game.BotsNecto.loadModel('nexto') });

  return { OptiBot };
})();
