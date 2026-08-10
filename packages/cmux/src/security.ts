import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/** cmux socket access mode. `allowAll` is never permitted for this bridge. */
export type CmuxSocketMode = "cmuxOnly" | "allowAll";

/** Spec §14 / threat-model: default and only admitted mode for the bridge. */
export const DEFAULT_CMUX_SOCKET_MODE: CmuxSocketMode = "cmuxOnly";

/** Control-plane variables that must never appear in a worker environment. */
export const CMUX_CONTROL_ENV_VARS = [
  "CMUX_SOCKET_PATH",
  "CMUX_WORKSPACE_ID",
  "CMUX_SURFACE_ID",
  "CMUX_SESSION_ID",
] as const;

export type CmuxControlEnvVar = (typeof CMUX_CONTROL_ENV_VARS)[number];

/**
 * Resolve the bridge's socket mode. Fails closed on `allowAll` and unknown
 * values — the bridge must not widen cmux access beyond `cmuxOnly`.
 */
export function resolveSocketMode(
  value: string | undefined = DEFAULT_CMUX_SOCKET_MODE,
): Result<CmuxSocketMode, AgentdError> {
  if (value === "cmuxOnly") return ok("cmuxOnly");
  if (value === "allowAll") {
    return err(
      makeError(
        "POLICY_DENIED",
        "CMUX_SOCKET_MODE allowAll is not permitted for the cmux bridge",
      ),
    );
  }
  return err(makeError("SCHEMA_INVALID", "CMUX_SOCKET_MODE is invalid"));
}

/**
 * Reject worker environment records that carry cmux control variables.
 * The bridge validates inputs it might forward; workers never receive these.
 */
export function rejectCmuxControlVarsInWorkerEnv(
  env: Readonly<Record<string, string | undefined>>,
): Result<void, AgentdError> {
  for (const name of CMUX_CONTROL_ENV_VARS) {
    if (env[name] !== undefined) {
      return err(
        makeError(
          "POLICY_DENIED",
          `worker environment must not include ${name}`,
        ),
      );
    }
  }
  return ok(undefined);
}
