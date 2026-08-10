/**
 * POSIX shell quoting for cmux terminal injection when only `send_text` exists.
 *
 * Each argv element is quoted independently so metacharacters cannot break out
 * of their argument boundary.
 */

const SAFE_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument for `/bin/sh -c` or an interactive shell line. */
export function posixShellQuote(argument: string): string {
  if (SAFE_ARG_PATTERN.test(argument)) return argument;
  const apostropheQuote = "'\"'\"'";
  return `'${argument.replaceAll("'", apostropheQuote)}'`;
}

/** Join argv into one shell line without invoking a shell to parse the input. */
export function posixShellJoin(argv: readonly string[]): string {
  return argv.map(posixShellQuote).join(" ");
}
