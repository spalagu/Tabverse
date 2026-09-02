import { invoke } from "@tauri-apps/api/core";
import {
  effectiveResidentMode,
  type ContinuousResidentContribution,
  type ResidentAttachReplay,
  type ResidentContribution,
  type ResidentPolicy,
  type ResidentRuntimePort,
  type ResidentRuntimeRef,
} from "@tabverse/tab-contracts";

export function createTauriResidentPort(
  call: typeof invoke = invoke,
): ResidentRuntimePort {
  return {
    ensure: (request) => call<ResidentRuntimeRef>("resident_ensure", { request }),
    list: () => call<readonly ResidentRuntimeRef[]>("resident_list"),
    attach: (runtimeId, lastAckSeq) =>
      call<ResidentAttachReplay>("resident_attach", { runtimeId, lastAckSeq }),
    poll: (runtimeId, lastAckSeq) =>
      call<ResidentAttachReplay>("resident_poll", { runtimeId, lastAckSeq }),
    intent: (runtimeId, payload) =>
      call<void>("resident_intent", { runtimeId, payload }),
    detach: (runtime) =>
      call<ResidentRuntimeRef>("resident_detach", { runtime }),
    stop: (runtime) => call<void>("resident_stop", { runtime }),
  };
}

export interface ResidentMountRequest {
  readonly tabId: string;
  readonly contribution: ResidentContribution | undefined;
  readonly policy: ResidentPolicy;
  readonly state: unknown;
  readonly catalogRevision: number;
}

export type ResidentMountResult =
  | { readonly mode: "none" | "state-only" }
  | { readonly mode: "continuous"; readonly runtime: ResidentRuntimeRef };

export interface ResidentTakeoverFailure {
  readonly runtime: ResidentRuntimeRef;
  readonly error: unknown;
}

/**
 * GUI lifecycle coordinator. It can request/attach/detach/stop but cannot
 * construct a worker; the native port terminates at ResidentSupervisor IPC.
 */
export class ResidentCoordinator {
  readonly #port: ResidentRuntimePort;
  readonly #requestId: () => string;
  readonly #runtimes = new Map<string, ResidentRuntimeRef>();
  readonly #transitions = new Map<string, Promise<void>>();
  #takeoverFailures: ResidentTakeoverFailure[] = [];

  constructor(
    port: ResidentRuntimePort,
    requestId: () => string = () => crypto.randomUUID(),
  ) {
    this.#port = port;
    this.#requestId = requestId;
  }

  runtime(tabId: string, runtimeKind?: string): ResidentRuntimeRef | undefined {
    if (runtimeKind !== undefined) return this.#runtimes.get(runtimeKey(tabId, runtimeKind));
    return [...this.#runtimes.values()].find((runtime) => runtime.tabId === tabId);
  }

  takeoverFailures(): readonly ResidentTakeoverFailure[] {
    return [...this.#takeoverFailures];
  }

  async mount(request: ResidentMountRequest): Promise<ResidentMountResult> {
    return await this.#forTab(request.tabId, async () => {
      const mode = effectiveResidentMode(request.contribution, request.policy);
      if (mode !== "continuous") return { mode };
      const contribution = request.contribution as ContinuousResidentContribution;
      if (!contribution.initialStateSchema.validate(request.state)) {
        throw new TypeError(
          `resident initial state does not match ${contribution.initialStateSchema.id}`,
        );
      }
      const key = runtimeKey(request.tabId, contribution.runtimeKind);
      const existing = this.#runtimes.get(key);
      if (existing) return { mode, runtime: existing };
      const descriptor = await contribution.descriptor();
      const runtime = await this.#port.ensure({
        tabId: request.tabId,
        kind: contribution.runtimeKind,
        descriptor,
        expectedCatalogRevision: request.catalogRevision,
        requestId: this.#requestId(),
        initialCheckpoint: request.state,
      });
      this.#runtimes.set(key, runtime);
      return { mode, runtime };
    });
  }

  /** App/window teardown never implies task termination. */
  async detachForAppExit(): Promise<void> {
    await this.#waitForTransitions();
    const entries = [...this.#runtimes.entries()];
    let firstError: unknown;
    for (const [key, runtime] of entries) {
      try {
        const detached = await this.#port.detach(runtime);
        this.#runtimes.set(key, detached);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Closing a Tab or explicitly switching it off is a stop decision. */
  async stopTab(tabId: string): Promise<void> {
    await this.#forTab(tabId, async () => {
      const owned = [...this.#runtimes.entries()].filter(
        ([, runtime]) => runtime.tabId === tabId,
      );
      // Remove ownership before awaiting IPC so queued pane cleanups cannot
      // issue duplicate stop requests for the same Supervisor runtime.
      for (const [key] of owned) this.#runtimes.delete(key);
      let firstError: unknown;
      for (const [key, runtime] of owned) {
        try {
          await this.#port.stop(runtime);
        } catch (error) {
          this.#runtimes.set(key, runtime);
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    });
  }

  /** A replacement App attaches the exact Supervisor-owned runtime refs. */
  async takeOver(lastAckByRuntime: Readonly<Record<string, number>> = {}): Promise<readonly ResidentAttachReplay[]> {
    await this.#waitForTransitions();
    const listed = await this.#port.list();
    const replays: ResidentAttachReplay[] = [];
    const failures: ResidentTakeoverFailure[] = [];
    for (const runtime of listed) {
      try {
        const replay = await this.#port.attach(
          runtime.runtimeId,
          lastAckByRuntime[runtime.runtimeId] ?? 0,
        );
        this.#runtimes.set(
          runtimeKey(replay.runtime.tabId, replay.runtime.kind),
          replay.runtime,
        );
        replays.push(replay);
      } catch (error) {
        // One stale/incompatible runtime must not prevent the replacement App
        // from taking over every other healthy Tab. Keep the exact failure
        // available to the product shell for diagnostics and recovery UI.
        failures.push({ runtime, error });
      }
    }
    this.#takeoverFailures = failures;
    return replays;
  }

  /**
   * Linearize every lifecycle mutation for one Tab. This closes the race in
   * which a policy-off/close stop observes no runtime while an earlier
   * Supervisor ensure is still in flight and that ensure completes later.
   */
  async #forTab<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitions.get(tabId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#transitions.set(tabId, settled);
    try {
      return await result;
    } finally {
      if (this.#transitions.get(tabId) === settled) {
        this.#transitions.delete(tabId);
      }
    }
  }

  async #waitForTransitions(): Promise<void> {
    while (this.#transitions.size > 0) {
      await Promise.all([...this.#transitions.values()]);
    }
  }
}

function runtimeKey(tabId: string, runtimeKind: string): string {
  return `${tabId}\u0000${runtimeKind}`;
}
