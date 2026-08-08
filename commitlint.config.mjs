// Commit convention. See docs/commits.md.
// Types come from @commitlint/config-conventional; scopes are the closed
// list of domains in this repository's layout (packages/, apps/, docs/).
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "agentd",
        "protocol",
        "core",
        "codex",
        "claude",
        "cursor",
        "antigravity",
        "worktrees",
        "sandbox",
        "policy",
        "observability",
        "testkit",
        "pi-extension",
        "cmux",
        "docs",
        "ci",
        "deps",
      ],
    ],
  },
};
