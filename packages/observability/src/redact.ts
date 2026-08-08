/**
 * Redaction.
 *
 * CLAUDE.md: "Never log tokens, credentials, raw environment variables, or
 * complete untrusted prompts by default." This module is the single place that
 * happens — every sink in the project routes through it, so there is one thing
 * to audit rather than a rule each caller is trusted to remember.
 *
 * Three independent layers, because each one misses cases the others catch:
 *
 *   1. **Key names.** The strongest signal. A field called `authorization` is
 *      redacted whatever it contains.
 *   2. **Value patterns.** Catches a credential that has leaked into free
 *      text — a token quoted inside an error message, a URL with userinfo.
 *   3. **Truncation.** Bounds anything left over, so an untrusted prompt or a
 *      megabyte of provider output cannot be logged whole.
 *
 * What it deliberately does *not* claim: this is not a guarantee. A secret
 * split across two fields, or one with no recognisable shape, will pass. The
 * defence that actually holds is not giving workers credentials they do not
 * need (spec §18); redaction is the second line, not the first.
 */

export const REDACTED = "[REDACTED]";
export const TRUNCATED_SUFFIX = "…[truncated]";

/** Values longer than this are truncated even when nothing matches. */
export const DEFAULT_MAX_STRING_LENGTH = 512;

/** Matches the traversal ceiling on event payloads. */
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

/**
 * Key names whose value is always redacted, matched case-insensitively against
 * the key with separators removed (`API_KEY`, `api-key` and `apiKey` all
 * normalise to `apikey`).
 */
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "privatekey",
  "sessionkey",
  "cookie",
  "auth",
  "signature",
  "clientsecret",
  "connectionstring",
] as const;

/**
 * Whole environment blocks are never logged. CLAUDE.md names "raw environment
 * variables" explicitly, and an env object is the densest concentration of
 * credentials in the process.
 */
const OPAQUE_KEY_PARTS = ["env", "environment", "processenv"] as const;

type SecretPattern = Readonly<{ name: string; pattern: RegExp }>;

/**
 * Value shapes that identify a credential regardless of where it appears.
 * Each is anchored on a vendor-specific prefix rather than on entropy, because
 * entropy heuristics produce false positives on git SHAs and digests — which
 * this project logs deliberately and needs to keep readable.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "openai", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "google", pattern: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // JWT: three base64url segments. The `eyJ` prefix is a base64-encoded `{"`.
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  {
    name: "pem",
    pattern:
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*KEY-----/g,
  },
  // Credentials in a URL's userinfo component: https://user:secret@host
  { name: "url-userinfo", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi },
  // `KEY=value` where the key names a credential.
  {
    name: "env-assignment",
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=\S+/g,
  },
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyIsSensitive(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function keyIsOpaque(key: string): boolean {
  const normalized = normalizeKey(key);
  return OPAQUE_KEY_PARTS.some((part) => normalized === part);
}

/** Size of an opaque value, so the log says how much was withheld. */
function countEntries(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return Object.keys(value).length;
}

/**
 * Replace credential-shaped substrings, preserving the surrounding text.
 *
 * The surrounding text is what makes a log entry useful, so this substitutes
 * in place rather than discarding the whole string.
 */
export function redactString(
  value: string,
  maxLength: number = DEFAULT_MAX_STRING_LENGTH,
): string {
  let out = value;

  for (const { name, pattern } of SECRET_PATTERNS) {
    // `lastIndex` is shared state on a global regex; reset before each use so
    // repeated calls cannot skip a match.
    pattern.lastIndex = 0;
    out =
      name === "url-userinfo"
        ? out.replace(pattern, `$1${REDACTED}@`)
        : out.replace(pattern, `[REDACTED:${name}]`);
  }

  if (out.length > maxLength) {
    return out.slice(0, maxLength) + TRUNCATED_SUFFIX;
  }
  return out;
}

export type RedactOptions = Readonly<{
  maxStringLength?: number;
  maxDepth?: number;
  maxNodes?: number;
}>;

/**
 * Redact an arbitrary value for logging.
 *
 * Cycles are replaced with `[Circular]` and the traversal is bounded in both
 * depth and node count: the input is frequently untrusted, and a redactor that
 * can be made to hang or overflow the stack is itself the vulnerability.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_NODES;

  let nodes = 0;
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > maxNodes) return "[TRUNCATED:too-many-values]";
    if (depth > maxDepth) return "[TRUNCATED:too-deep]";

    if (typeof node === "string") return redactString(node, maxStringLength);
    if (
      node === null ||
      typeof node === "number" ||
      typeof node === "boolean"
    ) {
      return node;
    }
    if (typeof node === "bigint") return `${node.toString()}n`;
    if (typeof node === "undefined") return undefined;
    if (typeof node === "function" || typeof node === "symbol") {
      return `[${typeof node}]`;
    }

    if (seen.has(node)) return "[Circular]";
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }

    if (node instanceof Error) {
      // Never spread an Error: `cause` routinely holds a provider or fs error
      // whose message carries paths, argv and environment fragments.
      return {
        name: node.name,
        message: redactString(node.message, maxStringLength),
      };
    }

    if (node instanceof Date) return node.toISOString();
    if (node instanceof Map || node instanceof Set) {
      return `[${node.constructor.name}:${String(node.size)}]`;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (keyIsSensitive(key)) {
        out[key] = REDACTED;
      } else if (keyIsOpaque(key)) {
        // Report the shape without any of the contents.
        out[key] = `[REDACTED:${String(countEntries(child))} entries]`;
      } else {
        out[key] = walk(child, depth + 1);
      }
    }
    return out;
  }

  return walk(value, 1);
}
