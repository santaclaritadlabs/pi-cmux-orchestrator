# Technical Specification — Pi + cmux Multi-Agent Orchestrator

**Versión:** 0.1
**Fecha:** 7 de agosto de 2026
**Nombre provisional:** `pi-cmux-orchestrator`

## 1. Objetivo

Construir un sistema de orquestación de agentes de desarrollo donde:

* **Pi Coding Agent** sea la interfaz principal y el agente que decide cómo descomponer y delegar trabajo.
* **Codex CLI, Claude Code, Cursor Agent y Antigravity CLI** actúen como workers intercambiables.
* **cmux** funcione como cockpit visual para observar, navegar e intervenir.
* Un componente propio llamado **`agentd`** supervise procesos, worktrees, estados y recuperación.
* Los agentes no se comuniquen directamente entre sí.
* Los repositorios potencialmente maliciosos se consideren contenido no confiable.
* Ningún repositorio pueda introducir silenciosamente extensiones, MCPs, hooks, skills o configuración ejecutable en el control plane.

Pi soporta extensiones TypeScript propias, tools y lifecycle hooks, además de un modo RPC JSONL; por tanto, no necesitamos introducir un framework de subagentes comunitario en el camino crítico.

---

# 2. Principio arquitectónico

La separación será:

```text
                    USER
                     │
                     ▼
              ┌──────────────┐
              │     cmux     │
              │   cockpit    │
              └──────┬───────┘
                     │
                     ▼
              ┌──────────────┐
              │      Pi      │
              │ decision     │
              │ plane        │
              └──────┬───────┘
                     │
             local JSON-RPC
               Unix socket
                     │
                     ▼
         ┌───────────────────────┐
         │        agentd         │
         │ deterministic        │
         │ execution supervisor │
         └───────────┬───────────┘
                     │
       ┌─────────────┼──────────────┬─────────────┐
       ▼             ▼              ▼             ▼
   Codex CLI     Claude Code    Cursor Agent   Antigravity
       │             │              │             │
       ▼             ▼              ▼             ▼
    worktree       worktree       worktree      worktree
```

La distinción importante es:

**Pi decide qué hacer. `agentd` garantiza que ocurra.**

Pi no mantiene PID, timeout, retries, worktrees ni logs como estado autoritativo.

Esto permite reiniciar Pi sin perder una ejecución.

---

# 3. Componentes

## 3.1 `pi-orchestrator` — implementación propia

Extensión global de Pi:

```text
~/.pi/agent/extensions/pi-orchestrator/
```

Responsabilidades:

* exponer tools a Pi;
* enviar comandos a `agentd`;
* mostrar estado;
* aplicar políticas de alto nivel;
* seleccionar agente;
* construir tareas;
* recibir resultados;
* decidir dependencias posteriores;
* solicitar aprobación humana cuando corresponda.

Tools iniciales:

```text
orchestrator_create_task
orchestrator_run_task
orchestrator_status
orchestrator_cancel
orchestrator_result
orchestrator_compare
orchestrator_integrate
```

Pi permite registrar estas tools directamente mediante `pi.registerTool()`.

La extensión debe instalarse **globalmente**, no dentro de los repositorios trabajados:

```text
~/.pi/agent/extensions/
```

Nunca:

```text
repo/.pi/extensions/
```

para el control plane.

---

# 4. `agentd` — implementación propia

`agentd` será un daemon TypeScript/Node separado de Pi.

Es la pieza más importante para estabilidad.

```text
agentd
 ├── Task Scheduler
 ├── Process Supervisor
 ├── Worktree Manager
 ├── Agent Adapters
 ├── Event Normalizer
 ├── Policy Engine
 ├── Run Store
 └── Sandbox Manager
```

Pi y `agentd` se comunicarán mediante:

```text
Unix socket
+
JSONL / JSON-RPC
```

Por ejemplo:

```json
{
  "id": "req-17",
  "method": "task.start",
  "params": {
    "task_id": "DTE-123",
    "agent": "codex"
  }
}
```

Respuesta:

```json
{
  "id": "req-17",
  "ok": true,
  "run_id": "run_01J..."
}
```

El socket:

```text
~/.local/run/pi-agentd.sock
```

debe tener permisos:

```text
0600
```

No habrá TCP listener por defecto.

---

# 5. Comunicación con los CLI agents

Cada CLI tendrá un adapter propio.

```ts
interface AgentRunner {
  capabilities(): AgentCapabilities;

  start(task: AgentTask): Promise<RunHandle>;

  events(
    run: RunHandle
  ): AsyncIterable<AgentEvent>;

  cancel(
    run: RunHandle
  ): Promise<void>;

  collectResult(
    run: RunHandle
  ): Promise<AgentResult>;
}
```

Implementaciones:

```text
CodexRunner
ClaudeRunner
CursorRunner
AntigravityRunner
```

Los adapters deben encapsular **todas** las peculiaridades del proveedor.

Pi nunca deberá conocer argumentos como:

```text
--output-format
--force
--sandbox
--permission-mode
--json-schema
```

Eso pertenece al adapter.

---

# 6. Transporte utilizado por cada agente

## Codex

Base:

```text
codex exec --json
```

Codex genera JSONL para automatización y soporta `--output-schema`, así como sandboxes `read-only`, `workspace-write` y `danger-full-access`. OpenAI recomienda `workspace-write` para ejecución unattended local y reservar el bypass del sandbox para entornos externos aislados.

**Perfil recomendado:**

```text
trusted implementation:
    workspace-write

review:
    read-only

untrusted:
    external sandbox/VM
    +
    read-only inicialmente
```

---

## Claude Code

Base:

```text
claude -p \
  --output-format stream-json
```

Claude Code soporta además:

```text
--input-format stream-json
--json-schema
--max-turns
--max-budget-usd
--permission-mode
--allowed-tools
--disallowed-tools
--bare
--safe-mode
```

lo que lo hace especialmente adecuado para un adapter controlado.

Para repositorios desconocidos usar:

```text
--bare
```

o, para máxima exclusión de personalizaciones:

```text
--safe-mode
```

según el tipo de operación. Claude documenta que estos modos eliminan gran parte del auto-discovery de plugins, skills, MCPs, hooks y CLAUDE.md.

---

## Cursor Agent

Base:

```text
agent -p \
  --output-format stream-json
```

`cursor-agent` continúa disponible como alias.

Cursor documenta `json` y `stream-json`, con eventos NDJSON, session ID y tool-call IDs.

No diseñaría el parser suponiendo que todo:

```text
tool_call:started
```

tendrá necesariamente un:

```text
tool_call:completed
```

porque se han reportado pérdidas de eventos después de reconexiones, así como algunos stalls del modo headless. Por ello Cursor debe ser considerado inicialmente un worker **at-least-once / partially observable**, no una fuente autoritativa del estado del filesystem.

El estado real se verificará siempre mediante:

```text
PID
exit code
git diff
filesystem
tests
final event
```

No solo mediante su stream.

---

## Antigravity CLI

Base:

```text
agy -p \
  --output-format stream-json
```

Desde la versión CLI 1.1.8 del 28 de julio de 2026 soporta:

* `json`;
* `stream-json`;
* eventos NDJSON tipados;
* `--json-schema`;
* información de tools;
* información de subagentes;
* token accounting.

Además dispone de un permission engine:

```text
deny > ask > allow
```

para archivos, comandos, URLs, MCP y ejecución fuera de sandbox.

Esto convierte a Antigravity en un worker bastante apropiado para ejecuciones aisladas y revisiones independientes.

---

# 7. Protocolo normalizado

Los formatos nativos se transformarán a:

```ts
type AgentEvent =
  | StartedEvent
  | ProgressEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ArtifactEvent
  | WarningEvent
  | FinishedEvent
  | FailedEvent;
```

Ejemplo:

```json
{
  "version": 1,
  "run_id": "run_123",
  "task_id": "AUTH-41",
  "agent": "codex",
  "seq": 184,
  "timestamp": "2026-08-08T05:00:00Z",
  "type": "tool.completed",
  "data": {
    "tool": "shell",
    "exit_code": 0
  }
}
```

Todo evento tendrá:

```text
version
run_id
task_id
agent
seq
timestamp
type
data
```

Los adapters deben ignorar campos desconocidos recibidos de los CLIs.

---

# 8. `AgentTask`

Contrato central:

```ts
interface AgentTask {
  version: 1;

  id: string;

  objective: string;

  role:
    | "investigate"
    | "design"
    | "implement"
    | "test"
    | "review"
    | "security-review";

  workspace: {
    repo: string;
    worktree: string;
    baseCommit: string;
  };

  constraints: {
    allowedPaths?: string[];
    forbiddenPaths?: string[];

    network:
      | "none"
      | "allowlist"
      | "default";

    mayWrite: boolean;
    mayCommit: boolean;

    mayPush: false;
  };

  limits: {
    softTimeoutSeconds: number;
    hardTimeoutSeconds: number;
    maxTurns?: number;
    budgetUsd?: number;
  };

  dependencies: string[];

  resultSchema: string;
}
```

**`mayPush` será siempre `false` para workers.**

---

# 9. Resultado normalizado

```ts
interface AgentResult {
  version: 1;

  status:
    | "success"
    | "failed"
    | "blocked"
    | "cancelled";

  summary: string;

  findings: Finding[];

  changedFiles: string[];

  tests: TestResult[];

  artifacts: ArtifactRef[];

  git: {
    baseCommit: string;
    finalCommit?: string;
    dirty: boolean;
  };

  warnings: string[];
}
```

No existirá ningún campo:

```text
commandForNextAgent
executeThis
instructionsForParent
```

El worker reporta hechos.

**Pi genera las siguientes instrucciones.**

Esto reduce propagación de prompt injection entre agentes.

---

# 10. Estado de ejecución

State machine:

```text
QUEUED
  │
  ▼
PREPARING
  │
  ▼
RUNNING
  │
  ├────► BLOCKED
  │
  ├────► CANCELLED
  │
  ├────► FAILED
  │
  ▼
VALIDATING
  │
  ├────► FAILED
  │
  ▼
SUCCEEDED
```

También:

```text
ORPHANED
```

para procesos cuyo estado no pueda determinarse después de un restart.

---

# 11. Persistencia

Cada run:

```text
~/.local/share/pi-agentd/
└── runs/
    └── run_01J.../
        ├── task.json
        ├── state.json
        ├── events.ndjson
        ├── stdout.ndjson
        ├── stderr.log
        ├── result.json
        ├── metadata.json
        └── artifacts/
```

`state.json` se escribirá mediante:

```text
write temporary
fsync
atomic rename
```

`events.ndjson` será append-only.

Para la primera versión **no añadiría PostgreSQL, Redis ni una message queue**.

Eso elimina mucho failure surface.

---

# 12. Git isolation

Cada tarea escritora obtiene:

```text
git worktree
```

Ejemplo:

```text
.repo/
.worktrees/
    AUTH-41-codex/
    AUTH-42-claude/
    AUTH-43-cursor/
```

Branch:

```text
agent/AUTH-41/run-01J...
```

Dos workers escritores nunca compartirán working directory.

Los reviewers pueden recibir worktrees read-only o revisar commits existentes.

Flujo:

```text
agent branch
     │
     ▼
tests
     │
     ▼
independent review
     │
     ▼
integration worktree
     │
     ▼
human/quality gate
     │
     ▼
main
```

Los workers no hacen `push`.

---

# 13. cmux

cmux será estrictamente una interfaz.

cmux ya ofrece CLI y Unix socket para crear workspaces/surfaces, enviar input, emitir notificaciones y actualizar status/progress/logs en la sidebar.

Diseño:

```text
cmux
│
├── CONTROL
│     Pi
│
├── AUTH-41 · CODEX
│     tail -f events
│
├── AUTH-42 · CLAUDE
│     tail -f events
│
├── AUTH-43 · CURSOR
│     tail -f events
│
└── REVIEW
      integration/tests
```

**Los procesos de los agentes no necesitan vivir dentro del pane.**

El pane puede mostrar:

```text
agentd logs --follow run_01J...
```

Esto tiene una ventaja enorme:

> cerrar accidentalmente un workspace cmux no mata el worker.

Pi puede reconstruir toda la UI consultando `agentd`.

---

# 14. Seguridad del socket cmux

Mantener:

```text
CMUX_SOCKET_MODE=cmuxOnly
```

y nunca:

```text
allowAll
```

como default.

cmux documenta que `cmuxOnly` es su configuración predeterminada y limita el socket a procesos descendientes de terminales cmux.

`agentd` idealmente se ejecutará **fuera del árbol de procesos de cmux**.

Los workers no recibirán:

```text
CMUX_SOCKET_PATH
CMUX_WORKSPACE_ID
CMUX_SURFACE_ID
```

Esto evita convertir el control de cmux en una capacidad implícita del worker.

---

# 15. Threat model: repositorios maliciosos

Todo repositorio externo comienza como:

```text
UNTRUSTED
```

Pi advierte expresamente que su project trust **no es un sandbox**, que sus extensiones tienen los permisos completos del usuario y que prompt injection desde archivos del repositorio es un riesgo esperado.

Además, `AGENTS.md` y `CLAUDE.md` pueden cargarse aunque Pi no confíe en el proyecto salvo que se desactive el context loading.

Por tanto:

```text
UNTRUSTED
   │
   ▼
Security Intake
   │
   ▼
Quarantined Sandbox
   │
   ▼
Review
   │
   ├── reject
   │
   └── trusted
```

---

# 16. Security Intake

Antes de ejecutar código:

```text
scan:
    AGENTS.md
    CLAUDE.md

    .pi/
    .claude/
    .cursor/
    .agents/

    MCP configs
    hooks

    package.json
    lockfiles

    Makefile

    scripts/

    .github/workflows/

    Dockerfiles

    git hooks

    shell scripts
```

La inspección inicial con Pi debe utilizar:

```text
--no-context-files
--no-approve
--no-extensions
--no-skills
```

y solamente tools read-only.

Pi soporta específicamente esos controles.

---

# 17. Sandbox

Para contenido verdaderamente no confiable:

```text
Host
│
├── cmux
├── Pi
├── agentd
│
└── Sandbox / VM
     └── worker
          └── repo copy
```

El sandbox no debe recibir:

```text
~/.ssh
~/.aws
~/.config/gcloud
Docker socket
cmux socket
host home
GitHub credentials
production secrets
```

El repo preferiblemente será **copiado**, no montado read/write desde el host.

---

# 18. Política de secretos

Cada worker recibe únicamente los secretos necesarios para su proveedor.

Ejemplo:

```text
Codex worker
    OpenAI auth only

Claude worker
    Anthropic auth only
```

Nunca:

```text
all credentials → every worker
```

La documentación de Codex recuerda que su `auth.json` contiene tokens y debe tratarse como una contraseña.

---

# 19. Extensiones de terceros

## Dependencias obligatorias

**Ninguna extensión de Pi de terceros.**

Esta es una decisión deliberada.

---

## `pi-interactive-subagents`

Clasificación:

```text
OPTIONAL
```

Uso permitido:

```text
Pi
 ├── Pi scout
 ├── Pi planner
 └── Pi reviewer
```

No:

```text
Pi
 ├── Codex
 ├── Cursor
 └── Antigravity
```

como infraestructura principal.

`pi-interactive-subagents` ofrece una excelente integración Pi→Pi con cmux, agentes asíncronos, status y steering; sin embargo, algunas operaciones —por ejemplo interruption— son explícitamente Pi-specific.

Además, la versión 3.7.2 actualmente publicada declara peer dependencies bajo el namespace histórico `@mariozechner/*`, mientras la documentación actual de Pi utiliza `@earendil-works/*`. No implica necesariamente incompatibilidad, pero sí constituye un punto que deberíamos verificar y pinnear antes de introducirla.

Mi política sería:

```text
NO:
pi install git:github.com/HazAT/pi-interactive-subagents
```

directamente como dependencia flotante.

Si decidimos usarla:

```text
upstream GitHub
     │
     ▼
security review
     │
     ▼
internal fork
     │
     ▼
exact commit SHA
     │
     ▼
tests
     │
     ▼
internal installation
```

Su `package.json` actual no contiene lifecycle install scripts y tiene una superficie de runtime relativamente pequeña, lo cual es favorable, pero una extensión de Pi continúa ejecutándose con los permisos del usuario.

---

# 20. Otras extensiones Pi comunitarias

No incorporaría inicialmente:

```text
pi-subagents
@mjakl/pi-subagent
otros orchestrators
```

No porque sean necesariamente inseguros, sino porque duplican responsabilidades que necesitamos controlar nosotros y aumentan supply-chain + compatibility surface. Existen varias implementaciones comunitarias de subagents, pero no aportan una capacidad imprescindible para este diseño.

---

# 21. Supply-chain policy

Toda dependencia externa deberá cumplir:

```text
exact version / exact SHA
lockfile committed
no floating main/master
no automatic plugin updates
review lifecycle scripts
review transitive dependencies
record source + checksum
test before promotion
```

Para Pi, la instalación oficial mediante npm admite:

```text
npm install -g --ignore-scripts \
  @earendil-works/pi-coding-agent
```

y Pi no necesita install scripts para la instalación npm normal.

Aplicaría el mismo principio siempre que sea posible.

---

# 22. Routing de agentes

Pi recibe:

```text
objective
risk
complexity
repo characteristics
```

y genera:

```text
Task DAG
```

Ejemplo:

```text
                  ┌─► Codex implementation ───┐
                  │                            │
Pi plan ─► Scout ─┤                            ├─► Claude review
                  │                            │
                  └─► Cursor tests ────────────┤
                                               │
                       Antigravity security ───┘
```

Pi debe evitar usar cinco agentes cuando uno es suficiente.

---

# 23. Estrategia de modelos para construir el orchestrator

## Diseño arquitectónico

**Principal: Claude Code + Claude Opus 4.8**

```text
effort = high
```

Para decisiones particularmente difíciles:

```text
effort = xhigh
```

Opus 4.8 está específicamente orientado a coding, agentes complejos y ejecuciones largas; Anthropic recomienda `high` como balance general y `xhigh` para trabajos especialmente difíciles o largos.

Lo usaría para:

```text
architecture
threat model
state machine
failure semantics
concurrency model
security boundaries
ADRs
```

---

# 24. Challenger del diseño

**Codex + GPT-5.6 Sol**

```text
reasoning = xhigh
```

para una revisión independiente del diseño.

GPT-5.6 Sol es actualmente el modelo flagship de OpenAI para razonamiento y coding complejo y soporta hasta `max` reasoning effort.

Reservaría:

```text
max
```

para unas pocas actividades:

```text
final concurrency audit
security boundary audit
failure recovery audit
```

No para desarrollo cotidiano.

---

# 25. Implementación del core

**Principal: Codex + GPT-5.6 Sol**

```text
effort = high
```

Áreas:

```text
agentd
scheduler
process supervisor
worktree manager
event store
normalized types
tests
```

Usaría `xhigh` solamente para:

```text
concurrency
process lifecycle
recovery
race conditions
```

---

# 26. Pi extension y cmux integration

**Claude Sonnet 5 o Codex GPT-5.6 Sol**

```text
effort = high
```

Sonnet 5 tiene una relación capability/cost mucho mejor que Opus para implementación cotidiana y Anthropic lo posiciona precisamente para agentic coding sostenido.

No necesitamos Opus para implementar wrappers sencillos.

---

# 27. Adapters

Para evitar que un proveedor implemente únicamente su propio adapter, haría revisión cruzada.

```text
ClaudeAdapter
    implementation → Codex
    validation     → Claude Code

CodexAdapter
    implementation → Claude Code
    validation     → Codex

CursorAdapter
    implementation → Codex
    validation     → Cursor + Claude

AntigravityAdapter
    implementation → Codex
    validation     → Antigravity + Claude
```

Todos:

```text
high effort
```

salvo bugs particularmente difíciles.

---

# 28. Security review

Dos revisores independientes:

```text
Claude Opus 4.8 xhigh

+

GPT-5.6 Sol xhigh
```

Deben revisar independientemente y Pi fusiona los findings.

No permitiría que el agente que escribió una pieza sea su único reviewer.

---

# 29. Papel de Cursor

Inicialmente:

```text
secondary implementation
test generation
independent review
UI-oriented changes
```

No lo pondría aún como único worker del camino crítico debido a los reports recientes de stalls y anomalías de eventos en headless mode.

Después de un soak test satisfactorio puede adquirir el mismo nivel que Codex/Claude.

Cursor permite seleccionar dinámicamente modelos mediante `agent models`/`--model`, así que el adapter no debe fijar nombres permanentes en código.

---

# 30. Papel de Antigravity

Lo usaría particularmente para:

```text
independent investigation
integration validation
security-oriented review
long-running auxiliary jobs
```

Default:

```text
Gemini 3.1 Pro
high effort
```

y para scouts de bajo costo:

```text
Gemini 3.5 Flash
medium
```

La disponibilidad actual de Antigravity incluye Gemini 3.1 Pro y Gemini 3.5 Flash en todos los planes; otros modelos dependen del plan.

Antigravity CLI añadió `--effort` y model slugs estables en julio de 2026.

---

# 31. Modelo para Pi en operación normal

No usaría el modelo más caro para cada decisión del orchestrator.

Default:

```text
Pi orchestrator
    GPT-5.6 Terra medium

          o

    Claude Sonnet 5 medium
```

Promoción automática:

```text
simple routing
    medium

complex decomposition
    high

architectural decision
    Opus/Sol high

critical/high-risk
    Opus/Sol xhigh
```

GPT-5.6 Terra está diseñado precisamente como el punto medio entre capacidad y coste dentro de GPT-5.6.

---

# 32. Fases de implementación

## P0 — Contracts

Implementar únicamente:

```text
AgentTask
AgentEvent
AgentResult
AgentRunner
RunState
```

* fixtures reales de output de los cuatro CLIs.

**No orchestration todavía.**

---

## P1 — `agentd`

Implementar:

```text
Unix RPC
RunStore
ProcessSupervisor
CodexAdapter
cancel
timeouts
recovery
```

Conseguir primero:

```text
Pi → agentd → Codex
```

completamente estable.

---

## P2 — Multi-agent

Añadir:

```text
ClaudeAdapter
CursorAdapter
AntigravityAdapter
WorktreeManager
```

---

## P3 — Pi

Añadir:

```text
pi-orchestrator extension
task DAG
routing
review workflows
```

---

## P4 — cmux

Añadir:

```text
workspace creation
titles
status pills
progress
logs
notifications
tail surfaces
```

cmux soporta todas estas primitivas mediante su API.

---

## P5 — Hardening

Añadir:

```text
quarantine mode
sandbox manager
permission profiles
secret minimization
dependency audit
prompt-injection tests
crash recovery tests
fuzzing of NDJSON parsers
```

---

# 33. Acceptance criteria

El MVP se considera correcto cuando puede:

```text
1. crear 4 worktrees;

2. ejecutar simultáneamente:
   Codex
   Claude
   Cursor
   Antigravity;

3. normalizar los cuatro event streams;

4. sobrevivir al restart de Pi;

5. cancelar cualquier worker;

6. detectar un worker colgado;

7. reconstruir estado desde disco;

8. impedir que dos escritores compartan worktree;

9. impedir push desde workers;

10. rechazar resultados inválidos;

11. reconstruir la UI cmux después de reiniciar Pi;

12. ejecutar un repo untrusted sin exponer secretos del host.
```

---

# 34. Tests críticos

Especial prioridad:

```text
partial NDJSON records
malformed JSON
unknown event types
process killed
network disconnect
missing terminal event
duplicate events
out-of-order events
adapter crash
Pi crash
agentd restart
cmux closed
worktree conflict
git dirty state
timeout during shell
prompt injection in agent output
malicious AGENTS.md
malicious CLAUDE.md
malicious MCP config
malicious npm lifecycle script
```

---

# 35. Repositorio propuesto

```text
pi-cmux-orchestrator/
│
├── apps/
│   └── agentd/
│
├── packages/
│   ├── protocol/
│   ├── core/
│   ├── process-supervisor/
│   ├── worktrees/
│   ├── security/
│   ├── adapters/
│   │   ├── codex/
│   │   ├── claude/
│   │   ├── cursor/
│   │   └── antigravity/
│   └── cmux/
│
├── extensions/
│   └── pi-orchestrator/
│
├── schemas/
│   ├── task.schema.json
│   ├── result.schema.json
│   └── event.schema.json
│
├── fixtures/
│   ├── codex/
│   ├── claude/
│   ├── cursor/
│   └── antigravity/
│
├── tests/
│   ├── integration/
│   ├── recovery/
│   ├── security/
│   └── adapters/
│
└── docs/
    ├── architecture.md
    ├── threat-model.md
    ├── protocol.md
    └── adr/
```

---

# 36. Dependencias externas finales

### Obligatorias

```text
cmux                    official
Pi Coding Agent         official
Codex CLI               official
Claude Code             official
Cursor Agent            official
Antigravity CLI         official
git
Node.js
```

### Extensiones comunitarias obligatorias

```text
NONE
```

### Opcional

```text
internal audited fork
of pi-interactive-subagents
```

únicamente para:

```text
Pi → Pi delegation
```

---

# 37. Decisión final

La arquitectura recomendada es:

```text
cmux
    visual plane

Pi
    intelligent decision plane

agentd
    deterministic execution plane

AgentRunner adapters
    provider abstraction

git worktrees
    write isolation

VM/container
    trust isolation
```

El principio clave es:

> **Los modelos pueden decidir; nunca deben ser quienes garanticen el estado del sistema.**

PID management, locking, worktrees, retries, timeouts, validation, persistence y políticas de seguridad pertenecen a código determinista propio.

Y el segundo principio:

> **Ninguna extensión GitHub comunitaria será necesaria para que el sistema funcione.**

Eso reduce drásticamente tanto los problemas de estabilidad como el riesgo de supply-chain.
