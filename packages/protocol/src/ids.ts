/**
 * Identifiers.
 *
 * Run IDs are ULIDs (`run_01J...`, as the spec writes them). ULID rather than
 * UUIDv4 because run state lives in `~/.local/share/pi-agentd/runs/<runId>/`:
 * a lexicographically sortable ID means the directory listing is already in
 * creation order, so recovery can walk runs oldest-first without opening a
 * single `state.json`.
 *
 * Task IDs are supplied by the caller (`AUTH-41`, `DTE-123`). Because a task ID
 * can reach a filesystem path, its charset is restricted here — this is a path
 * traversal control, not cosmetics.
 */

import { randomBytes } from "node:crypto";

import { InvariantViolation } from "./errors.ts";

/** Crockford Base32: no I, L, O or U, so IDs cannot be misread aloud. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;

/** 48 bits of timestamp; 10 base32 chars carry 50, the top 2 stay zero. */
const TIME_LEN = 10;
/** 80 bits of randomness across 16 base32 chars. */
const RANDOM_LEN = 16;

const MAX_TIME_MS = 2 ** 48 - 1;

export const RUN_ID_PREFIX = "run_";

/**
 * A ULID's first character encodes the top bits of a 48-bit timestamp, so it
 * can never exceed 7. Anything else is not a ULID we produced.
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const RUN_ID_PATTERN = /^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Task IDs appear in directory names and in audit records. The charset
 * deliberately excludes `/`, `\`, NUL and `.` as a leading character, so no
 * task ID can traverse out of the runs directory or name a dotfile.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Map a 5-bit value to its Crockford character.
 *
 * The bounds check is not ceremony: every caller derives `digit` from a modulo
 * that is provably in range, so an out-of-range value means an arithmetic bug.
 * Without the check, `ENCODING[digit]` would be `undefined` and silently
 * concatenate the string "undefined" into an identifier — producing an ID that
 * looks plausible, fails `isUlid`, and names a run directory.
 */
function encodeDigit(digit: number): string {
  const char = ENCODING[digit];
  if (char === undefined) {
    throw new InvariantViolation(`base32 digit out of range: ${String(digit)}`);
  }
  return char;
}

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
    throw new InvariantViolation(
      `ULID timestamp out of range: ${String(timeMs)}`,
    );
  }
  let remaining = timeMs;
  let out = "";
  for (let i = 0; i < TIME_LEN; i += 1) {
    const digit = remaining % ENCODING_LEN;
    out = encodeDigit(digit) + out;
    remaining = (remaining - digit) / ENCODING_LEN;
  }
  return out;
}

/**
 * 16 uniform base32 digits. `256 % 32 === 0`, so the modulo introduces no bias
 * and each digit is a clean 5 bits.
 */
function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (byte) => byte % ENCODING_LEN);
}

/** Add one to the base32 number held in `digits`, in place. */
function incrementDigits(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = digits[i];
    if (digit === undefined) throw new InvariantViolation("digit index");
    if (digit < ENCODING_LEN - 1) {
      digits[i] = digit + 1;
      return;
    }
    digits[i] = 0;
  }
  // Would need 2^80 IDs inside a single millisecond.
  throw new InvariantViolation("ULID randomness exhausted within one tick");
}

function digitsToString(digits: readonly number[]): string {
  let out = "";
  for (const digit of digits) out += encodeDigit(digit);
  return out;
}

export type UlidFactory = () => string;

/**
 * Build a monotonic ULID generator.
 *
 * Two guarantees beyond plain ULID, both required for run IDs to be usable as
 * an ordering key:
 *
 *   - Within one millisecond, the random component is incremented rather than
 *     redrawn, so IDs strictly increase.
 *   - If the clock moves backwards (NTP correction, suspend/resume), the
 *     previous timestamp is reused and incremented instead of emitting a
 *     smaller ID. A run created later never sorts before one created earlier.
 *
 * `now` is injectable so tests can drive the clock, including backwards.
 */
export function createUlidFactory(now: () => number = Date.now): UlidFactory {
  let lastTimeMs = -1;
  let lastDigits: number[] = [];

  return function ulid(): string {
    const observed = now();
    // Clock regression: pin to the last emitted timestamp.
    const timeMs = observed > lastTimeMs ? observed : lastTimeMs;

    if (timeMs === lastTimeMs) {
      incrementDigits(lastDigits);
    } else {
      lastTimeMs = timeMs;
      lastDigits = randomDigits();
    }

    return encodeTime(timeMs) + digitsToString(lastDigits);
  };
}

/** Process-wide generator. Tests should build their own with a fake clock. */
export const ulid: UlidFactory = createUlidFactory();

export function createRunId(factory: UlidFactory = ulid): string {
  return RUN_ID_PREFIX + factory();
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

/** Milliseconds encoded in a ULID, or `undefined` if it is not one. */
export function ulidTimeMs(value: string): number | undefined {
  const ulidPart = value.startsWith(RUN_ID_PREFIX)
    ? value.slice(RUN_ID_PREFIX.length)
    : value;
  if (!isUlid(ulidPart)) return undefined;

  let timeMs = 0;
  for (const char of ulidPart.slice(0, TIME_LEN)) {
    const digit = ENCODING.indexOf(char);
    if (digit < 0) return undefined;
    timeMs = timeMs * ENCODING_LEN + digit;
  }
  return timeMs;
}
