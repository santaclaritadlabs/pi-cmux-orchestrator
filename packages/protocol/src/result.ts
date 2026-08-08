/**
 * Typed failure channel.
 *
 * CLAUDE.md: "Use `Result`-style typed failures for expected operational
 * errors. Reserve exceptions for programmer defects and unrecoverable startup
 * failures."
 *
 * Everything that can fail because of *input* or *environment* — a malformed
 * task, a denied policy decision, a worker that exited nonzero — returns a
 * `Result`. Throwing is reserved for states that mean the code itself is
 * wrong.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** Transform the success value, leaving a failure untouched. */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the error, leaving a success untouched. */
export function mapError<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chain a fallible step; short-circuits on the first failure. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Collect a list of results into a result of a list, failing on the first
 * error. Used when validating a batch of events read back from disk.
 */
export function allOk<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Bridge a throwing call into the `Result` world.
 *
 * Only for boundaries we do not own (`node:fs`, `JSON.parse`). Do not use it to
 * paper over our own invariants — those should not throw in the first place.
 */
export function tryCatch<T, E>(
  fn: () => T,
  onThrow: (cause: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onThrow(cause));
  }
}

export async function tryCatchAsync<T, E>(
  fn: () => Promise<T>,
  onThrow: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onThrow(cause));
  }
}
