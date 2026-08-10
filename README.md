# pi-cmux-orchestrator

Local-first, secure multi-agent development orchestrator. **Pi decides what to
do; `agentd` guarantees it happens** — task lifecycle, policy, worktrees, and
worker processes stay in deterministic code, not in the UI or the model.

## Platform support

| Platform             | Status                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**            | Primary development target; best tested.                                                                                                                                            |
| **Linux**            | Supported; CI runs on Ubuntu.                                                                                                                                                       |
| **Windows (native)** | **Not supported.** The control plane relies on Unix domain sockets, POSIX `ps`, and directory `fsync` semantics that Windows does not provide. Native Windows remains out of scope. |

**Practical notes**

- **`agentd` RPC** uses a local Unix socket (`~/.local/run/pi-agentd.sock` by
  default). Override with `AGENTD_RUNTIME_DIR` if `$HOME` is long enough to hit
  the ~104-byte socket path limit on macOS.
- **Git** must be available; every mutable task gets its own worktree.
- **Provider CLIs** (Codex, Claude Code, Cursor, Antigravity) are installed and
  authenticated separately by the operator.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 22.18 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) ≥ 10.33
- [Pi](https://pi.dev/) (`npm install -g @mariozechner/pi-coding-agent`) on your `PATH`
- A clone of this repository (the Pi extension is workspace-internal; it is not
  published to npm — see
  [`docs/adr/0012-pi-extension-distribution.md`](docs/adr/0012-pi-extension-distribution.md))

## Install the Pi extension

From the repository root:

```bash
git clone https://github.com/santaclaritadlabs/pi-cmux-orchestrator.git
cd pi-cmux-orchestrator
pnpm install
pnpm install:pi-extension
```

The installer runs `pnpm install --frozen-lockfile`, builds the workspace, and
writes a loader to `~/.pi/agent/extensions/pi-cmux-orchestrator.js`. Pi
auto-discovers that directory on startup.

**Custom extension directory**

```bash
pnpm install:pi-extension -- --target "$HOME/.config/pi/extensions"
# or: PI_EXTENSION_DIR=... pnpm install:pi-extension
```

For a non-default directory, add the loader path to the `extensions` array in
`~/.pi/agent/settings.json`, or load once with `pi -e <loader-path>`.

The loader points at this checkout's compiled entrypoint — **keep the checkout
in place** after installation and only install from a trusted source. Details:
[`apps/pi-extension/README.md`](apps/pi-extension/README.md).

## Run `agentd`

The daemon can run from this checkout or from npm:

```bash
# from checkout (after pnpm build)
pnpm --filter @pi-cmux/agentd exec agentd serve

# or published bundle
npm install -g @pi-cmux/agentd
agentd serve
```

Set `AGENTD_SOCKET_PATH` / `AGENTD_TOKEN_PATH` only when using non-default
paths. cmux is optional; headless operation does not require it.

## Development

```bash
pnpm hooks:install   # once per clone — commit-msg convention
pnpm verify          # format + lint + typecheck + test
```

| Command                     | Description                     |
| --------------------------- | ------------------------------- |
| `pnpm build`                | Compile all packages            |
| `pnpm test`                 | Build and run tests             |
| `pnpm lint`                 | ESLint                          |
| `pnpm install:pi-extension` | Build and install the Pi loader |

## Documentation

- [Architecture](docs/architecture.md) — Pi, `agentd`, cmux, adapters
- [Protocol](docs/protocol.md) — task, event, and result contract
- [Threat model](docs/threat-model.md) — trust boundaries and known limits
- [Contributing](CONTRIBUTING.md) — development workflow and conventions

## License

[Apache License 2.0](LICENSE)
