/**
 * The closed set of capabilities a task may request.
 *
 * `constraints.capabilities` is a list of strings, and a bounded string is not
 * a contract: it accepts `"repo.write"` and `"definitely-not-a-real-thing"`
 * equally, and a policy engine that never compares the list against anything
 * admits both. CLAUDE.md is explicit that unknown capabilities must fail
 * closed, so the set is enumerated here and checked in policy.
 *
 * The failure this prevents is a quiet one. An unrecognised capability today is
 * merely inert — nothing reads it, so nothing acts on it — and a task carrying
 * it is admitted and audited as *allowed*. The audit trail then records a
 * permission that was never enforced, and the day a later phase gives that
 * string a meaning, every task that has been carrying it silently acquires the
 * new power without any rule having been changed to grant it.
 *
 * Adding a capability here is a protocol change: it widens what a task may ask
 * for, so it belongs with the schemas rather than in a policy profile. Policy
 * decides whether a *known* capability is available in the current phase; this
 * decides whether it is a capability at all.
 */

export const CAPABILITIES = [
  /** Read the assigned worktree. Implied by every task, listable explicitly. */
  "repo.read",
  /** Modify files inside the assigned worktree. Requires `mayWrite`. */
  "repo.write",
  /** Execute the repository's test command inside the sandbox. */
  "test.run",
  /** Outbound network. Requires a `network` mode other than `deny`. */
  "net.fetch",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/**
 * The requested capabilities that this build does not recognise.
 *
 * Returns the offenders rather than a boolean so a denial can name them: a
 * refusal that says only "unknown capability" leaves the operator diffing lists
 * by hand. Duplicates are already rejected by the task schema.
 */
export function unknownCapabilities(
  requested: readonly string[],
): readonly string[] {
  return requested.filter((capability) => !isCapability(capability));
}

// The registry must stay inside the schema's own `maxCapabilities` bound, or a
// task could not request every capability at once and the two limits would
// silently disagree. That is asserted in `capabilities.test.ts` rather than
// here: today the comparison is statically true, so a runtime check would be
// dead code, but it stops being true the moment someone adds enough entries.
