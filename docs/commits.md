# Commit convention

All commits follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced locally by a `commit-msg` hook and authoritatively in CI for
pull-request commits.

## Format

    type(scope): description

- `type` — one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
  `build`, `ci`, `perf`, `revert`.
- `scope` — optional; when present, one of the domains below. Prefer a scope
  for any change confined to a single domain.
- `description` — imperative, lowercase, no trailing period.

### Scopes

| Scope                                      | Domain                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `agentd`                                   | `apps/agentd` — daemon, RPC server              |
| `protocol`                                 | `packages/protocol` — task/event/result schemas |
| `core`                                     | `packages/core` — lifecycle, scheduler          |
| `codex`, `claude`, `cursor`, `antigravity` | `packages/adapters/*`                           |
| `worktrees`                                | `packages/worktrees`                            |
| `sandbox`                                  | `packages/sandbox`                              |
| `policy`                                   | `packages/policy`                               |
| `observability`                            | `packages/observability`                        |
| `testkit`                                  | `packages/testkit`                              |
| `pi-extension`                             | `apps/pi-extension`                             |
| `cmux`                                     | cmux integration                                |
| `docs`                                     | `docs/` and other prose                         |
| `ci`                                       | `.github/workflows` and tooling config          |
| `deps`                                     | dependency changes                              |

## Examples

    feat(codex): normalize tool events
    fix(protocol): validate artifact digests on ingest
    chore: bump lockfile
    ci: validate pull request commit messages

## Hooks

Hooks are plain git hooks committed in `.husky/` and wired through
`core.hooksPath` — no husky package, no lifecycle scripts. After cloning or
creating a worktree, run once:

    pnpm hooks:install

`core.hooksPath` is shared repository config, so one install covers every
worktree.

| Hook         | Runs                                                   |
| ------------ | ------------------------------------------------------ |
| `pre-commit` | `lint-staged` — eslint + prettier on staged files only |
| `commit-msg` | `commitlint --edit` — format, type and scope           |

Hooks are local convenience; CI re-validates PR commits and is the
authoritative gate.
