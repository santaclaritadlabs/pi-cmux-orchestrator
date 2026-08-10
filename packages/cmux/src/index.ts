export {
  createCmuxClient,
  type CmuxClient,
  type CmuxClientOptions,
  type CmuxSurfaceRef,
  type CmuxWorkspaceRef,
  type CreateSurfaceInput,
  type CreateWorkspaceInput,
} from "./client.ts";
export { DEFAULT_CMUX_CLI, runCmuxCli } from "./cli-transport.ts";
export { FakeCmuxTransport, type FakeRpcHandler } from "./fake-transport.ts";
export {
  isCmuxRpcResponse,
  type CmuxRpcFailure,
  type CmuxRpcRequest,
  type CmuxRpcResponse,
  type CmuxRpcSuccess,
} from "./protocol.ts";
export {
  CMUX_CONTROL_ENV_VARS,
  DEFAULT_CMUX_SOCKET_MODE,
  rejectCmuxControlVarsInWorkerEnv,
  resolveSocketMode,
  type CmuxControlEnvVar,
  type CmuxSocketMode,
} from "./security.ts";
export {
  attachLogTailSurface,
  buildLogTailCommand,
  createLogTailCommand,
  LOG_TAIL_INDEPENDENCE,
  type AttachLogTailSurfaceInput,
} from "./log-tail.ts";
export {
  createRunLayout,
  formatControlSurfaceTitle,
  formatLogSurfaceTitle,
  formatWorkspaceTitle,
  MAX_LAYOUT_TITLE_CHARS,
  RunLayoutStore,
  truncateLayoutTitle,
  type RunLayoutInput,
  type RunLayoutRef,
} from "./layout.ts";
export {
  isTerminalRunState,
  notifyTerminalTransition,
  TerminalNotificationGuard,
  terminalNotificationMessage,
  TERMINAL_RUN_STATES,
  type RunState,
} from "./notifications.ts";
export {
  createCmuxApiSink,
  progressForSnapshot,
  type CmuxApiSinkOptions,
} from "./sink.ts";
export {
  DEFAULT_CMUX_SOCKET_PATH,
  createSocketTransport,
  resolveCmuxSocketPath,
  type SocketTransportOptions,
} from "./socket-transport.ts";
export {
  createCompositeTransport,
  type CompositeTransportOptions,
  type CmuxTransport,
} from "./transport.ts";
