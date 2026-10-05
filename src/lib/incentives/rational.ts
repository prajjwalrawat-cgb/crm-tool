/**
 * Exact rational arithmetic over BigInt, for the incentive engine.
 *
 * WHY NOT PLAIN NUMBERS
 * The workbook's own worked example breaks IEEE-754: a 18% blended margin
 * against a 20% floor is `0.18 / 0.2`, which JS evaluates to
 * 0.8999999999999999, and `6 * that` to 5.3999999999999995 — not the ₹5.4 L
 * the workbook (and the SPOC) expects. Every step of the model is + − × ÷,
 * floor, min or max, so it is closed over the rationals: carrying exact
 * fractions end to end and rounding ONCE, at the output edge, reproduces the
 * spreadsheet to the paisa and gives byte-identical output on every run.
 *
 * Pure + client-safe. Uses `BigInt(...)` rather than `0n` literals because the
 * project targets ES2017.
 */

const ZERO_B = BigInt(0);
const ONE_B = BigInt(1);
const TEN_B = BigInt(10);

function abs(a: bigint): bigint {
  return a < ZERO_B ? -a : a;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== ZERO_B) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export class Rational {
  /** Numerator; carries the sign. */
  readonly n: bigint;
  /** Denominator; always > 0. */
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === ZERO_B) throw new RangeError('Rational: division by zero');
    if (d < ZERO_B) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.n = g > ONE_B ? n / g : n;
    this.d = g > ONE_B ? d / g : d;
  }

  static readonly ZERO = new Rational(ZERO_B, ONE_B);
  static readonly ONE = new Rational(ONE_B, ONE_B);

  static of(n: bigint, d: bigint = ONE_B): Rational {
    return new Rational(n, d);
  }

  /**
   * Parse a decimal string ("0.25", "-1.5", "1e-7") or a finite number.
   * Numbers go through `String(x)`, which is the shortest round-tripping
   * decimal — so `0.1` parses as exactly 1/10, not as the binary double.
   * Postgres `numeric` columns arrive as strings and parse exactly.
   */
  static parse(value: string | number): Rational {
    const s = (typeof value === 'number' ? String(value) : value).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
      throw new TypeError(`Rational: not a decimal number: ${JSON.stringify(value)}`);
    }
    const sign = m[1] === '-' ? -ONE_B : ONE_B;
    const intPart = m[2] || '0';
    const frac = m[3] ?? '';
    const exp = m[4] ? Number(m[4]) : 0;
    let n = BigInt(intPart + frac) * sign;
    let d = TEN_B ** BigInt(frac.length);
    if (exp > 0) n *= TEN_B ** BigInt(exp);
    if (exp < 0) d *= TEN_B ** BigInt(-exp);
    return new Rational(n, d);
  }

  add(o: Rational): Rational {
    return new Rational(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Rational): Rational {
    return new Rational(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Rational): Rational {
    return new Rational(this.n * o.n, this.d * o.d);
  }
  div(o: Rational): Rational {
    return new Rational(this.n * o.d, this.d * o.n);
  }

  cmp(o: Rational): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Rational): boolean {
    return this.cmp(o) === 0;
  }
  lt(o: Rational): boolean {
    return this.cmp(o) < 0;
  }
  lte(o: Rational): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Rational): boolean {
    return this.cmp(o) > 0;
  }
  gte(o: Rational): boolean {
    return this.cmp(o) >= 0;
  }
  isZero(): boolean {
    return this.n === ZERO_B;
  }
  isNegative(): boolean {
    return this.n < ZERO_B;
  }

  static min(a: Rational, b: Rational): Rational {
    return a.lte(b) ? a : b;
  }
  static max(a: Rational, b: Rational): Rational {
    return a.gte(b) ? a : b;
  }

  /** Largest integer ≤ this (true floor, also for negatives). */
  floor(): Rational {
    let q = this.n / this.d; // truncates toward zero
    if (this.n < ZERO_B && q * this.d !== this.n) q -= ONE_B;
    return new Rational(q, ONE_B);
  }

  /** Smallest integer ≥ this. */
  ceil(): Rational {
    const f = this.floor();
    return f.eq(this) ? f : f.add(Rational.ONE);
  }

  /**
   * Decimal string rounded half away from zero to `dp` places — the
   * spreadsheet ROUND() convention. Always exactly `dp` decimals.
   */
  toFixed(dp: number): string {
    const scale = TEN_B ** BigInt(dp);
    const neg = this.n < ZERO_B;
    const num = abs(this.n) * scale;
    let q = num / this.d;
    const rem = num % this.d;
    if (rem * BigInt(2) >= this.d) q += ONE_B;
    let digits = q.toString();
    if (dp > 0) {
      digits = digits.padStart(dp + 1, '0');
      digits = `${digits.slice(0, -dp)}.${digits.slice(-dp)}`;
    }
    return neg && q !== ZERO_B ? `-${digits}` : digits;
  }

  /** A JS number, rounded to `dp` places first so it is deterministic. */
  toNumber(dp = 6): number {
    return Number(this.toFixed(dp));
  }
}

export type Decimalish = string | number | Rational;

export function R(v: Decimalish): Rational {
  return v instanceof Rational ? v : Rational.parse(v);
}
