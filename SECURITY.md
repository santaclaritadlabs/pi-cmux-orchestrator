# Security Policy

Security is a core design requirement of `pi-cmux-orchestrator`.

This project launches and supervises AI coding agents that may execute commands, modify source code, access development tools, and process potentially untrusted repositories. Vulnerabilities affecting isolation, permissions, secret handling, command execution, agent communication, or repository trust boundaries are therefore treated as security-sensitive.

## Supported Versions

Until the project reaches its first stable release, security fixes are provided for the latest version of the `main` branch.

After stable releases begin, this section will identify which release lines continue to receive security updates.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for a suspected security vulnerability.

Preferred reporting method:

1. Use GitHub's private vulnerability reporting feature for this repository, when available.
2. If private vulnerability reporting is unavailable, contact:

`security@santaclaritadlabs.com`

Maintainers will acknowledge valid reports as soon as reasonably possible, assess their impact, and provide status updates during remediation when contact details are available.

Please include, when possible:

- affected version or commit;
- operating system and environment;
- affected agent or adapter;
- reproduction steps;
- proof of concept;
- expected versus actual behavior;
- potential impact;
- whether credentials, host files, sockets, or other trust boundaries can be accessed.

Do not include real secrets, production credentials, or other sensitive data in the report.

## Security-Sensitive Areas

Reports involving any of the following are especially important:

- sandbox escape;
- arbitrary host command execution;
- command execution outside configured permissions;
- access to host credentials or secrets;
- access to SSH, cloud, GitHub, or provider credentials;
- access to the `agentd` local RPC socket or other control-plane interfaces from an untrusted worker;
- unauthorized Git operations;
- unauthorized push or remote modification;
- worktree isolation failures;
- cross-agent prompt injection;
- propagation of untrusted agent output into control instructions;
- malicious `AGENTS.md`, `CLAUDE.md`, Cursor rules, Pi extensions, skills, hooks, MCP configurations, or equivalent repository-controlled instructions;
- dependency or plugin supply-chain attacks;
- privilege escalation between workers and the control plane;
- bypasses of network restrictions;
- sandbox configuration failures;
- unsafe recovery after an `agentd` crash or restart.

## Threat Model

The project assumes that:

- repositories may contain malicious content;
- repository instructions may contain prompt injections;
- generated agent output is untrusted;
- coding agents may make incorrect or unsafe decisions;
- third-party CLI tools may change behavior across versions;
- third-party extensions and dependencies may be compromised;
- worktrees provide concurrency isolation but are not security sandboxes.

The architecture therefore separates:

- **Pi** — decision plane;
- **agentd** — deterministic execution plane;
- **cmux** — visual/control interface;
- **agent workers** — constrained execution;
- **git worktrees** — concurrent write isolation;
- **VMs/containers/sandboxes** — trust isolation.

## Disclosure

Please allow maintainers reasonable time to investigate and prepare a fix before publicly disclosing a vulnerability.

When appropriate, the project will publish a GitHub Security Advisory describing the impact, affected versions, remediation, and reporter credit.
