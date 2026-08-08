/**
 * Choosing isolation, fail-closed.
 *
 * The rule CLAUDE.md states — "If required isolation is unavailable, reject the
 * task; do not silently fall back to the host" — is implemented here as the
 * *absence* of a fallback path rather than as a check. `required` selects only
 * from providers that satisfy it; when that set is empty there is nothing to
 * return, so the refusal is structural.
 *
 * Registration order is preference order. The first provider that can serve the
 * request wins, so an operator expresses "prefer the VM, fall back to the
 * seatbelt" by listing them in that order rather than by tuning a score.
 */

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
  type SandboxMode,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";

import {
  satisfiesRequired,
  type SandboxAvailability,
  type SandboxCapabilities,
  type SandboxKind,
  type SandboxPlacement,
  type SandboxProvider,
  type SandboxRequest,
} from "./provider.ts";

export type ProviderDescription = Readonly<{
  id: string;
  kind: SandboxKind;
  availability: SandboxAvailability;
}>;

export type SandboxSelection = Readonly<{
  provider: SandboxProvider;
  capabilities: SandboxCapabilities;
  /** True when the task asked for isolation and did not get an enforcing one. */
  degraded: boolean;
}>;

export class SandboxRegistry {
  readonly #providers: readonly SandboxProvider[];
  readonly #logger: Logger;

  public constructor(
    providers: readonly SandboxProvider[],
    options: { logger?: Logger } = {},
  ) {
    this.#providers = providers;
    this.#logger = (options.logger ?? nullLogger).child({
      component: "sandbox",
    });
  }

  public get providerIds(): readonly string[] {
    return this.#providers.map((provider) => provider.id);
  }

  /** Probe every provider. This is the capability discovery surface. */
  public async describe(): Promise<readonly ProviderDescription[]> {
    const described: ProviderDescription[] = [];
    for (const provider of this.#providers) {
      described.push({
        id: provider.id,
        kind: provider.kind,
        availability: await provider.probe(),
      });
    }
    return described;
  }

  /** True when at least one provider can enforce `sandbox: "required"`. */
  public async canEnforceIsolation(): Promise<boolean> {
    for (const description of await this.describe()) {
      if (
        description.availability.available &&
        satisfiesRequired(description.availability.capabilities)
      ) {
        return true;
      }
    }
    return false;
  }

  public async select(
    mode: SandboxMode,
  ): Promise<Result<SandboxSelection, AgentdError>> {
    const described = await this.describe();
    const available = described.filter(
      (
        description,
      ): description is ProviderDescription &
        Readonly<{
          availability: { available: true; capabilities: SandboxCapabilities };
        }> => description.availability.available,
    );

    const enforcing = available.filter((description) =>
      satisfiesRequired(description.availability.capabilities),
    );

    if (mode === "required") {
      const chosen = enforcing[0];
      if (chosen === undefined) {
        return err(
          makeError(
            "SANDBOX_UNAVAILABLE",
            "the task requires isolation and no provider can enforce it",
            { details: { probed: described.length } },
          ),
        );
      }
      return ok({
        provider: this.#byId(chosen.id),
        capabilities: chosen.availability.capabilities,
        degraded: false,
      });
    }

    // `preferred` takes an enforcing provider when one exists and settles for a
    // weaker one when it does not — that is what distinguishes it from
    // `required`, and the degradation is reported rather than assumed harmless.
    const chosen =
      mode === "preferred" ? (enforcing[0] ?? available[0]) : available[0];

    if (chosen === undefined) {
      return err(
        makeError(
          "SANDBOX_UNAVAILABLE",
          "no sandbox provider is available on this host",
          { details: { probed: described.length } },
        ),
      );
    }

    const degraded =
      mode === "preferred" &&
      !satisfiesRequired(chosen.availability.capabilities);

    if (degraded) {
      this.#logger.warn("running without enforced isolation", {
        provider: chosen.id,
        mode,
      });
    }

    return ok({
      provider: this.#byId(chosen.id),
      capabilities: chosen.availability.capabilities,
      degraded,
    });
  }

  #byId(id: string): SandboxProvider {
    const provider = this.#providers.find((candidate) => candidate.id === id);
    // `describe` only ever reports providers from this list.
    if (provider === undefined) {
      throw new Error(
        `sandbox provider '${id}' vanished between probe and use`,
      );
    }
    return provider;
  }

  /**
   * Select and prepare in one step.
   *
   * Preparation can still fail after a successful selection — a denied path, a
   * network request the provider cannot honour — and that failure is the task's
   * refusal, not a reason to try the next provider. Falling through to a weaker
   * provider after a rejection is how a fail-closed system becomes fail-open.
   */
  public async prepare(
    mode: SandboxMode,
    request: SandboxRequest,
  ): Promise<Result<SandboxPlacement, AgentdError>> {
    const selected = await this.select(mode);
    if (!selected.ok) return selected;
    return await selected.value.provider.prepare(request);
  }
}
