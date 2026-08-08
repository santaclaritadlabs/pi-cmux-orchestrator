/**
 * The host provider: no isolation, and honest about it.
 *
 * It exists so that "run on the host" is a *provider* with declared (empty)
 * capabilities rather than an implicit fallback. The difference shows up in
 * selection: a task requiring isolation cannot be satisfied by something whose
 * capabilities are all `false`, so the refusal falls out of the same rule that
 * chooses a real sandbox, instead of needing a special case that someone can
 * forget to write.
 *
 * Declaring no capabilities does not mean enforcing nothing. This provider
 * still refuses a task whose write surface reaches host credentials, and still
 * refuses network it cannot actually restrict — those checks do not depend on
 * isolation, so there is no reason to skip them.
 */

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { assertContained } from "@pi-cmux/policy";
import { buildWorkerEnvironment } from "@pi-cmux/process-supervisor";

import { assertNoneDenied, deniedHostPaths } from "./denied-paths.ts";
import {
  NO_CAPABILITIES,
  type SandboxAvailability,
  type SandboxPlacement,
  type SandboxProvider,
  type SandboxRequest,
} from "./provider.ts";

export const HOST_PROVIDER_ID = "host";

export class HostSandboxProvider implements SandboxProvider {
  public readonly id = HOST_PROVIDER_ID;
  public readonly kind = "none" as const;

  public async probe(): Promise<SandboxAvailability> {
    // Always available, never isolating. Both halves are the point.
    return await Promise.resolve({
      available: true,
      capabilities: NO_CAPABILITIES,
    });
  }

  public async prepare(
    request: SandboxRequest,
  ): Promise<Result<SandboxPlacement, AgentdError>> {
    const denied = deniedHostPaths({
      ...(request.home === undefined ? {} : { home: request.home }),
      ...(request.extraDeniedPaths === undefined
        ? {}
        : { extra: request.extraDeniedPaths }),
    });

    // The worktree first: if the worktree itself sits on top of something
    // sensitive, none of the narrower paths matter.
    const worktreeChecked = await assertNoneDenied(
      [request.worktreePath],
      denied,
    );
    if (!worktreeChecked.ok) return worktreeChecked;

    const pathsChecked = await assertNoneDenied(request.allowedPaths, denied);
    if (!pathsChecked.ok) return pathsChecked;

    // Every declared write surface must also be inside the worktree. Policy
    // checks this at admission; it is checked again here because this is the
    // last point before a process exists, and admission may have been minutes
    // and one symlink ago.
    for (const allowed of request.allowedPaths) {
      const contained = await assertContained(allowed, request.worktreePath);
      if (!contained.ok) return contained;
    }

    if (request.network !== "deny") {
      return err(
        makeError(
          "NETWORK_DENIED",
          "this provider cannot restrict network access, so it cannot grant it",
          { details: { requested: request.network, provider: this.id } },
        ),
      );
    }

    return ok({
      providerId: this.id,
      kind: this.kind,
      capabilities: NO_CAPABILITIES,
      cwd: request.worktreePath,
      // Nothing wraps the worker: it is spawned directly by the supervisor.
      argvPrefix: [],
      env: buildWorkerEnvironment({
        source: process.env,
        ...(request.secrets === undefined ? {} : { extra: request.secrets }),
      }),
    });
  }
}
