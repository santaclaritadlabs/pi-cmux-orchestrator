import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FORBIDDEN_ENV_VARS,
  buildWorkerEnvironment,
  forbiddenNamesIn,
} from "./environment.ts";

describe("the environment is built, not inherited", () => {
  it("starts empty when given no source", () => {
    assert.deepEqual(Object.keys(buildWorkerEnvironment()), []);
  });

  it("has a null prototype, so a hostile name cannot pollute it", () => {
    // With an ordinary object literal, a variable called `__proto__` would set
    // the prototype instead of becoming a property — and could then appear on
    // every other object in the process.
    const env = buildWorkerEnvironment({
      extra: { ["__proto__"]: "polluted", ["constructor"]: "polluted" },
    });

    assert.equal(Object.getPrototypeOf(env), null);
    assert.equal(env["__proto__"], "polluted", "must be an own property");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("carries over only allowlisted names", () => {
    const env = buildWorkerEnvironment({
      source: {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        OPENAI_API_KEY: "sk-live-secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "ghp_secret",
        SOME_INTERNAL_URL: "https://internal",
      },
    });

    assert.equal(env["PATH"], "/usr/bin");
    assert.equal(env["HOME"], "/home/dev");
    // Everything else is absent — not deleted afterwards, never copied.
    assert.equal(env["OPENAI_API_KEY"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
    assert.equal(env["GITHUB_TOKEN"], undefined);
    assert.equal(env["SOME_INTERNAL_URL"], undefined);
  });

  it("does not leak a real environment wholesale", () => {
    // The failure this guards: switching to `{...process.env}` for
    // convenience. Anything secret in the parent must not appear.
    const env = buildWorkerEnvironment({ source: process.env });
    const names = Object.keys(env);
    assert.ok(
      names.length < 15,
      `too many variables carried over: ${names.join(",")}`,
    );
    for (const name of names) {
      assert.doesNotMatch(name, /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i);
    }
  });

  it("passes provider credentials only when given explicitly", () => {
    // Spec §18: a Codex worker gets OpenAI auth and nothing else.
    const env = buildWorkerEnvironment({
      source: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-other" },
      extra: { OPENAI_API_KEY: "sk-for-this-worker" },
    });

    assert.equal(env["OPENAI_API_KEY"], "sk-for-this-worker");
    assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  });

  it("lets an explicit value override an allowlisted one", () => {
    const env = buildWorkerEnvironment({
      source: { HOME: "/home/dev" },
      extra: { HOME: "/sandbox/home" },
    });
    assert.equal(env["HOME"], "/sandbox/home");
  });

  it("widens the allowlist only when asked", () => {
    const source = { PATH: "/usr/bin", CI: "true" };
    assert.equal(buildWorkerEnvironment({ source })["CI"], undefined);
    assert.equal(
      buildWorkerEnvironment({ source, allow: ["CI"] })["CI"],
      "true",
    );
  });

  it("skips a name that is absent from the source", () => {
    const env = buildWorkerEnvironment({ source: { PATH: "/usr/bin" } });
    assert.equal(Object.hasOwn(env, "HOME"), false);
  });
});

describe("forbidden variables", () => {
  it("strips cmux control variables even when explicitly requested", () => {
    // Spec §14: holding CMUX_SOCKET_PATH is the ability to drive the cockpit.
    // That must never become an implicit worker capability.
    const env = buildWorkerEnvironment({
      source: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
      allow: ["CMUX_SOCKET_PATH"],
      extra: {
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
        CMUX_WORKSPACE_ID: "ws-1",
        CMUX_SURFACE_ID: "sf-1",
      },
    });

    assert.equal(env["CMUX_SOCKET_PATH"], undefined);
    assert.equal(env["CMUX_WORKSPACE_ID"], undefined);
    assert.equal(env["CMUX_SURFACE_ID"], undefined);
  });

  it("strips code-injection vectors", () => {
    const env = buildWorkerEnvironment({
      extra: {
        NODE_OPTIONS: "--inspect-brk=0.0.0.0:9229",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      },
    });

    assert.deepEqual(Object.keys(env), []);
  });

  it("reports which requested names would be refused", () => {
    const refused = forbiddenNamesIn({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--inspect",
      CMUX_SOCKET_PATH: "/tmp/s",
    });
    assert.deepEqual([...refused].sort(), ["CMUX_SOCKET_PATH", "NODE_OPTIONS"]);
  });

  it("keeps the forbidden list non-empty and covering both risks", () => {
    const names = new Set<string>(FORBIDDEN_ENV_VARS);
    assert.ok(names.has("CMUX_SOCKET_PATH"), "cmux control");
    assert.ok(names.has("NODE_OPTIONS"), "code injection");
    assert.ok(names.has("LD_PRELOAD"), "code injection");
  });
});
