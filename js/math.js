// Minimal vector/rotation math mirroring the Bullet types RocketSim is written against:
// btVector3, row-major btMatrix3x3, btQuaternion and btTransformUtil::integrateTransform.
window.Game = window.Game || {};

Game.Math = (function () {
  const SIMD_EPSILON = 1.1920929e-7; // FLT_EPSILON
  const ANGULAR_MOTION_THRESHOLD = 0.5 * Math.PI / 2;

  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    static from(a) { return new Vec3(a[0], a[1], a[2]); }
    clone() { return new Vec3(this.x, this.y, this.z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
    mulVec(v) { return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
    neg() { return new Vec3(-this.x, -this.y, -this.z); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    cross(v) {
      return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
    }
    length2() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.length2()); }
    isZero() { return this.x === 0 && this.y === 0 && this.z === 0; }
    // RocketSim Vec::Normalized (zero vector stays zero)
    normalized() {
      const l = this.length();
      return l > SIMD_EPSILON * SIMD_EPSILON ? this.mul(1 / l) : new Vec3();
    }
    // btVector3::safeNormalize (falls back to +X)
    safeNormalized() {
      const l2 = this.length2();
      return l2 >= SIMD_EPSILON * SIMD_EPSILON ? this.mul(1 / Math.sqrt(l2)) : new Vec3(1, 0, 0);
    }
    addLocal(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    addScaledLocal(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    scaleLocal(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  }

  // Row-major 3x3 (e[row * 3 + col]) like btMatrix3x3; column i is local axis i in world space.
  class Mat3 {
    constructor(e) { this.e = e || [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
    clone() { return new Mat3(this.e.slice()); }
    col(i) { const e = this.e; return new Vec3(e[i], e[3 + i], e[6 + i]); }
    mulVec(v) {
      const e = this.e;
      return new Vec3(e[0] * v.x + e[1] * v.y + e[2] * v.z, e[3] * v.x + e[4] * v.y + e[5] * v.z, e[6] * v.x + e[7] * v.y + e[8] * v.z);
    }
    tmulVec(v) {
      const e = this.e;
      return new Vec3(e[0] * v.x + e[3] * v.y + e[6] * v.z, e[1] * v.x + e[4] * v.y + e[7] * v.z, e[2] * v.x + e[5] * v.y + e[8] * v.z);
    }
    // this * diag(d) * this^T  (btRigidBody::updateInertiaTensor)
    scaledTransposed(d) {
      const e = this.e, out = new Array(9);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          out[r * 3 + c] = e[r * 3] * d.x * e[c * 3] + e[r * 3 + 1] * d.y * e[c * 3 + 1] + e[r * 3 + 2] * d.z * e[c * 3 + 2];
        }
      }
      return new Mat3(out);
    }
    static fromColumns(a, b, c) { return new Mat3([a.x, b.x, c.x, a.y, b.y, c.y, a.z, b.z, c.z]); }

    // btMatrix3x3::setEulerYPR(yaw, pitch, roll) == setEulerZYX(roll, pitch, yaw)
    static fromEulerYPR(yaw, pitch, roll) {
      const ci = Math.cos(roll), cj = Math.cos(pitch), ch = Math.cos(yaw);
      const si = Math.sin(roll), sj = Math.sin(pitch), sh = Math.sin(yaw);
      const cc = ci * ch, cs = ci * sh, sc = si * ch, ss = si * sh;
      return new Mat3([
        cj * ch, sj * sc - cs, sj * cc + ss,
        cj * sh, sj * ss + cc, sj * cs - sc,
        -sj, cj * si, cj * ci
      ]);
    }
    // RocketSim Angle::ToRotMat
    static fromAngle(yaw, pitch, roll) { return Mat3.fromEulerYPR(yaw, -pitch, -roll); }

    // btMatrix3x3::getRotation -> [x, y, z, w]
    toQuat() {
      const m = this.e;
      const trace = m[0] + m[4] + m[8];
      const t = [0, 0, 0, 0];
      if (trace > 0) {
        let s = Math.sqrt(trace + 1);
        t[3] = s * 0.5;
        s = 0.5 / s;
        t[0] = (m[7] - m[5]) * s;
        t[1] = (m[2] - m[6]) * s;
        t[2] = (m[3] - m[1]) * s;
      } else {
        const i = m[0] < m[4] ? (m[4] < m[8] ? 2 : 1) : (m[0] < m[8] ? 2 : 0);
        const j = (i + 1) % 3, k = (i + 2) % 3;
        let s = Math.sqrt(m[i * 4] - m[j * 4] - m[k * 4] + 1);
        t[i] = s * 0.5;
        s = 0.5 / s;
        t[3] = (m[k * 3 + j] - m[j * 3 + k]) * s;
        t[j] = (m[j * 3 + i] + m[i * 3 + j]) * s;
        t[k] = (m[k * 3 + i] + m[i * 3 + k]) * s;
      }
      return t;
    }
    // btMatrix3x3::setRotation
    static fromQuat(q) {
      const [x, y, z, w] = q;
      const d = x * x + y * y + z * z + w * w, s = 2 / d;
      const xs = x * s, ys = y * s, zs = z * s;
      const wx = w * xs, wy = w * ys, wz = w * zs;
      const xx = x * xs, xy = x * ys, xz = x * zs;
      const yy = y * ys, yz = y * zs, zz = z * zs;
      return new Mat3([
        1 - (yy + zz), xy - wz, xz + wy,
        xy + wz, 1 - (xx + zz), yz - wx,
        xz - wy, yz + wx, 1 - (xx + yy)
      ]);
    }
  }

  function quatMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
      a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }

  // btTransformUtil::integrateTransform (exponential map). Returns { pos, rot }.
  function integrateTransform(pos, rot, linVel, angVel, dt) {
    const newPos = pos.add(linVel.mul(dt));
    const angle2 = angVel.length2();
    let angle = angle2 > SIMD_EPSILON ? Math.sqrt(angle2) : 0;
    if (angle * dt > ANGULAR_MOTION_THRESHOLD) angle = ANGULAR_MOTION_THRESHOLD / dt;

    let axis;
    if (angle < 0.001) {
      axis = angVel.mul(0.5 * dt - (dt * dt * dt) * 0.020833333333 * angle * angle);
    } else {
      axis = angVel.mul(Math.sin(0.5 * angle * dt) / angle);
    }
    const dorn = [axis.x, axis.y, axis.z, Math.cos(angle * dt * 0.5)];
    let q = quatMul(dorn, rot.toQuat());
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    if (ql > 0) q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
    const newRot = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) > SIMD_EPSILON ? Mat3.fromQuat(q) : rot.clone();
    return { pos: newPos, rot: newRot };
  }

  // btPlaneSpace1
  function planeSpace(n) {
    if (Math.abs(n.z) > Math.SQRT1_2) {
      const a = n.y * n.y + n.z * n.z, k = 1 / Math.sqrt(a);
      const p = new Vec3(0, -n.z * k, n.y * k);
      return [p, new Vec3(a * k, -n.x * p.z, n.x * p.y)];
    }
    const a = n.x * n.x + n.y * n.y, k = 1 / Math.sqrt(a);
    const p = new Vec3(-n.y * k, n.x * k, 0);
    return [p, new Vec3(-n.z * p.y, n.z * p.x, a * k)];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function sgn(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

  return { Vec3, Mat3, integrateTransform, planeSpace, clamp, sgn, SIMD_EPSILON };
})();
