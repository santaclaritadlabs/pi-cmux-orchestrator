/**
 * Fail closed when sandbox placement would run a worker outside its worktree.
 *
 * Lexical prefix checks are insufficient: a symlinked `cwd` can look contained
 * while resolving outside the assigned worktree.
 */

import path from "node:path";

import { assertContained } from "@pi-cmux/policy";
import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

export async function validateWorkerPlacement(
  cwd: string,
  worktreePath: string,
): Promise<Result<void, AgentdError>> {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(worktreePath)) {
    return err(
      makeError("PATH_ESCAPE", "worker placement requires absolute paths", {
        details: {
          cwdAbsolute: path.isAbsolute(cwd),
          worktreeAbsolute: path.isAbsolute(worktreePath),
        },
      }),
    );
  }

  const contained = await assertContained(cwd, worktreePath);
  if (!contained.ok) return err(contained.error);

  return ok(undefined);
}
