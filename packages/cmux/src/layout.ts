import {
  ok,
  type AgentdError,
  type Result,
  type WorkerKind,
} from "@pi-cmux/protocol";

import type { CmuxClient } from "./client.ts";
import { attachLogTailSurface } from "./log-tail.ts";

export const MAX_LAYOUT_TITLE_CHARS = 80;

export type RunLayoutInput = Readonly<{
  runId: string;
  taskId: string;
  workerKind: WorkerKind;
  title?: string | undefined;
}>;

export type RunLayoutRef = Readonly<{
  runId: string;
  workspaceId: string;
  controlSurfaceId: string;
  logSurfaceId: string;
}>;

/** In-memory idempotency guard: one cmux layout per agentd run id. */
export class RunLayoutStore {
  private readonly byRunId = new Map<string, RunLayoutRef>();
  private readonly inFlight = new Map<
    string,
    Promise<Result<RunLayoutRef, AgentdError>>
  >();

  public get(runId: string): RunLayoutRef | undefined {
    return this.byRunId.get(runId);
  }

  public remember(layout: RunLayoutRef): void {
    this.byRunId.set(layout.runId, layout);
  }

  /** Serialize concurrent creators for the same run id into one attempt. */
  public async runOnce(
    runId: string,
    create: () => Promise<Result<RunLayoutRef, AgentdError>>,
  ): Promise<Result<RunLayoutRef, AgentdError>> {
    const existing = this.byRunId.get(runId);
    if (existing !== undefined) return ok(existing);

    let pending = this.inFlight.get(runId);
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(async () => {
          const remembered = this.byRunId.get(runId);
          if (remembered !== undefined) return ok(remembered);
          return await create();
        })
        .finally(() => {
          this.inFlight.delete(runId);
        });
      this.inFlight.set(runId, pending);
    }

    return await pending;
  }
}

export function truncateLayoutTitle(text: string): string {
  if (text.length <= MAX_LAYOUT_TITLE_CHARS) return text;
  return `${text.slice(0, MAX_LAYOUT_TITLE_CHARS - 1)}…`;
}

export function formatWorkspaceTitle(input: RunLayoutInput): string {
  const workerLabel = input.workerKind.toUpperCase();
  const base = input.title ?? `${input.taskId} · ${workerLabel}`;
  return truncateLayoutTitle(base);
}

export function formatControlSurfaceTitle(taskId: string): string {
  return truncateLayoutTitle(`Pi · ${taskId}`);
}

export function formatLogSurfaceTitle(runId: string): string {
  return truncateLayoutTitle(`logs · ${runId}`);
}

/**
 * Create a cmux workspace and surfaces for one agentd run (spec §13).
 *
 * Layout:
 * - workspace titled `{taskId} · {WORKER}`
 * - CONTROL surface for Pi (no embedded worker process)
 * - log tail surface running `agentd logs --follow <runId>`
 *
 * Pass the same {@link RunLayoutStore} across calls to make creation idempotent
 * per `runId`.
 */
export async function createRunLayout(
  client: CmuxClient,
  input: RunLayoutInput,
  options: Readonly<{ store?: RunLayoutStore }> = {},
): Promise<Result<RunLayoutRef, AgentdError>> {
  const store = options.store ?? new RunLayoutStore();

  return await store.runOnce(input.runId, async () => {
    const existing = store.get(input.runId);
    if (existing !== undefined) return ok(existing);

    const workspace = await client.createWorkspace({
      runId: input.runId,
      title: formatWorkspaceTitle(input),
    });
    if (!workspace.ok) return workspace;

    const control = await client.createSurface({
      workspaceId: workspace.value.workspaceId,
      title: formatControlSurfaceTitle(input.taskId),
    });
    if (!control.ok) return control;

    const log = await attachLogTailSurface(client, {
      workspaceId: workspace.value.workspaceId,
      runId: input.runId,
      title: formatLogSurfaceTitle(input.runId),
    });
    if (!log.ok) return log;

    const layout: RunLayoutRef = {
      runId: input.runId,
      workspaceId: workspace.value.workspaceId,
      controlSurfaceId: control.value.surfaceId,
      logSurfaceId: log.value.surfaceId,
    };
    store.remember(layout);
    return ok(layout);
  });
}
