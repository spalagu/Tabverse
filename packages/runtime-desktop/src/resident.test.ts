import { describe, expect, it, vi } from "vitest";
import type {
  ContinuousResidentContribution,
  ResidentAttachReplay,
  ResidentRuntimePort,
  ResidentRuntimeRef,
} from "@tabverse/tab-contracts";
import { ResidentCoordinator, createTauriResidentPort } from "./resident";

const descriptor = {
  pluginId: "tabverse.fixture",
  pluginVersion: "1.0.0",
  artifactHash: "a".repeat(64),
  entrypoint: "fixture-worker",
  permissions: [],
  protocolRange: { min: 1, max: 2 },
  signature: "fixture-signature",
};

const contribution: ContinuousResidentContribution<Readonly<Record<string, unknown>>> = {
  capability: "continuous",
  runtimeKind: "fixture",
  descriptor: async () => descriptor,
  initialStateSchema: {
    id: "fixture.initial/v1",
    validate: (input): input is Readonly<Record<string, unknown>> =>
      input !== null && typeof input === "object" && !Array.isArray(input),
  },
  checkpointSchema: {
    id: "fixture.checkpoint/v1",
    validate: (input): input is Readonly<Record<string, unknown>> =>
      input !== null && typeof input === "object" && !Array.isArray(input),
  },
};

function runtime(overrides: Partial<ResidentRuntimeRef> = {}): ResidentRuntimeRef {
  return {
    runtimeId: "runtime-1",
    tabId: "tab-1",
    kind: "fixture",
    generation: 1,
    pluginVersion: "1.0.0",
    artifactSlot: "tabverse.fixture@1.0.0/hash",
    leaseId: "lease-1",
    ...overrides,
  };
}

function fixture() {
  const active = runtime();
  const detached = runtime({ generation: 2, leaseId: "" });
  const attached = runtime({ generation: 3, leaseId: "lease-3" });
  const replay: ResidentAttachReplay = {
    runtime: attached,
    checkpointSeq: 4,
    checkpoint: { value: 4 },
    events: [{ seq: 5, payload: { value: 5 } }],
  };
  const port: ResidentRuntimePort = {
    ensure: vi.fn(async () => active),
    list: vi.fn(async () => [detached]),
    attach: vi.fn(async () => replay),
    poll: vi.fn(async () => replay),
    intent: vi.fn(async () => undefined),
    detach: vi.fn(async () => detached),
    stop: vi.fn(async () => undefined),
  };
  return { port, active, detached, attached, replay };
}

describe("ResidentCoordinator", () => {
  it("maps the narrow port only to ResidentSupervisor bridge commands", async () => {
    const call = vi.fn(async (command: string) => {
      if (command === "resident_list") return [runtime()];
      if (command === "resident_attach") {
        return {
          runtime: runtime(),
          checkpointSeq: 0,
          checkpoint: {},
          events: [],
        };
      }
      if (command === "resident_detach" || command === "resident_ensure") return runtime();
      return undefined;
    });
    const port = createTauriResidentPort(call as never);
    const request = {
      tabId: "tab-1",
      kind: "fixture",
      descriptor,
      expectedCatalogRevision: 4,
      requestId: "request-1",
      initialCheckpoint: {},
    };
    await port.ensure(request);
    await port.list();
    await port.attach("runtime-1", 9);
    await port.poll("runtime-1", 10);
    await port.intent("runtime-1", { type: "fixture" });
    await port.detach(runtime());
    await port.stop(runtime());
    expect(call.mock.calls).toEqual([
      ["resident_ensure", { request }],
      ["resident_list"],
      ["resident_attach", { runtimeId: "runtime-1", lastAckSeq: 9 }],
      ["resident_poll", { runtimeId: "runtime-1", lastAckSeq: 10 }],
      ["resident_intent", { runtimeId: "runtime-1", payload: { type: "fixture" } }],
      ["resident_detach", { runtime: runtime() }],
      ["resident_stop", { runtime: runtime() }],
    ]);
    expect(call.mock.calls.some(([command]) => command.includes("spawn"))).toBe(false);
  });

  it("only asks Supervisor ensure once and exposes no GUI spawn path", async () => {
    const { port, active } = fixture();
    const coordinator = new ResidentCoordinator(port, () => "request-1");
    const request = {
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "on", tab: "inherit" } as const,
      state: { value: 0 },
      catalogRevision: 7,
    };
    await expect(coordinator.mount(request)).resolves.toEqual({
      mode: "continuous",
      runtime: active,
    });
    await coordinator.mount(request);
    expect(port.ensure).toHaveBeenCalledTimes(1);
    expect(port.ensure).toHaveBeenCalledWith({
      tabId: "tab-1",
      kind: "fixture",
      descriptor,
      expectedCatalogRevision: 7,
      requestId: "request-1",
      initialCheckpoint: { value: 0 },
    });
    expect("spawn" in port).toBe(false);
  });

  it.each([
    ["on", "off"],
    ["off", "inherit"],
  ] as const)("app=%s tab=%s never resolves a descriptor or ensures", async (appDefault, tab) => {
    const { port } = fixture();
    const resolve = vi.fn(contribution.descriptor);
    const coordinator = new ResidentCoordinator(port);
    await expect(coordinator.mount({
      tabId: "tab-1",
      contribution: { ...contribution, descriptor: resolve },
      policy: { appDefault, tab },
      state: {},
      catalogRevision: 0,
    })).resolves.toEqual({ mode: "none" });
    expect(resolve).not.toHaveBeenCalled();
    expect(port.ensure).not.toHaveBeenCalled();
  });

  it("keeps state-only honest even when both policy levels are on", async () => {
    const { port } = fixture();
    const coordinator = new ResidentCoordinator(port);
    await expect(coordinator.mount({
      tabId: "files-1",
      contribution: { capability: "state-only", runtimeKind: "files" },
      policy: { appDefault: "on", tab: "on" },
      state: { cwd: "/workspace" },
      catalogRevision: 0,
    })).resolves.toEqual({ mode: "state-only" });
    expect(port.ensure).not.toHaveBeenCalled();
  });

  it("detaches on App exit, then a replacement App lists and attaches the same runtime", async () => {
    const { port, detached, attached, replay } = fixture();
    const coordinator = new ResidentCoordinator(port, () => "request-1");
    await coordinator.mount({
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "on", tab: "inherit" },
      state: {},
      catalogRevision: 0,
    });
    await coordinator.detachForAppExit();
    expect(port.detach).toHaveBeenCalledTimes(1);
    expect(port.stop).not.toHaveBeenCalled();
    expect(coordinator.runtime("tab-1")).toEqual(detached);

    const replacement = new ResidentCoordinator(port);
    await expect(replacement.takeOver({ "runtime-1": 4 })).resolves.toEqual([replay]);
    expect(port.attach).toHaveBeenCalledWith("runtime-1", 4);
    expect(replacement.runtime("tab-1")).toEqual(attached);
  });

  it("isolates one failed takeover while attaching every healthy runtime", async () => {
    const { port, replay } = fixture();
    const broken = runtime({ runtimeId: "runtime-broken", tabId: "tab-broken" });
    vi.mocked(port.list).mockResolvedValue([broken, runtime()]);
    vi.mocked(port.attach).mockImplementation(async (runtimeId) => {
      if (runtimeId === broken.runtimeId) throw new Error("incompatible runtime");
      return replay;
    });
    const replacement = new ResidentCoordinator(port);

    await expect(replacement.takeOver()).resolves.toEqual([replay]);
    expect(port.attach).toHaveBeenCalledTimes(2);
    expect(replacement.runtime("tab-1")).toEqual(replay.runtime);
    expect(replacement.takeoverFailures()).toEqual([
      { runtime: broken, error: expect.objectContaining({ message: "incompatible runtime" }) },
    ]);
  });

  it("stops only on explicit Tab close or policy-off action", async () => {
    const { port, active } = fixture();
    const coordinator = new ResidentCoordinator(port, () => "request-1");
    await coordinator.mount({
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "off", tab: "on" },
      state: {},
      catalogRevision: 0,
    });
    await coordinator.stopTab("tab-1");
    await coordinator.stopTab("tab-1");
    expect(port.stop).toHaveBeenCalledTimes(1);
    expect(port.stop).toHaveBeenCalledWith(active);
    expect(coordinator.runtime("tab-1")).toBeUndefined();
  });

  it("coalesces concurrent pane cleanup into one Supervisor stop", async () => {
    const { port } = fixture();
    let release!: () => void;
    vi.mocked(port.stop).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const coordinator = new ResidentCoordinator(port, () => "request-1");
    await coordinator.mount({
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "off", tab: "on" },
      state: {},
      catalogRevision: 0,
    });
    const first = coordinator.stopTab("tab-1");
    const second = coordinator.stopTab("tab-1");
    await vi.waitFor(() => expect(port.stop).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(port.stop).toHaveBeenCalledTimes(1);
  });

  it("linearizes a close behind an in-flight Supervisor ensure", async () => {
    const { port, active } = fixture();
    let releaseEnsure!: (runtime: ResidentRuntimeRef) => void;
    vi.mocked(port.ensure).mockImplementation(
      () => new Promise<ResidentRuntimeRef>((resolve) => { releaseEnsure = resolve; }),
    );
    const coordinator = new ResidentCoordinator(port, () => "request-1");
    const mounting = coordinator.mount({
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "off", tab: "on" },
      state: {},
      catalogRevision: 0,
    });
    await vi.waitFor(() => expect(port.ensure).toHaveBeenCalledTimes(1));

    const stopping = coordinator.stopTab("tab-1");
    expect(port.stop).not.toHaveBeenCalled();
    releaseEnsure(active);

    await mounting;
    await stopping;
    expect(port.stop).toHaveBeenCalledWith(active);
    expect(coordinator.runtime("tab-1")).toBeUndefined();
  });

  it("attempts every continuous task and retains only failed stops", async () => {
    const { port, active } = fixture();
    const second = runtime({ runtimeId: "runtime-2", kind: "fixture-2" });
    vi.mocked(port.ensure).mockImplementation(async (request) =>
      request.kind === "fixture-2" ? second : active,
    );
    vi.mocked(port.stop).mockImplementation(async (runtime) => {
      if (runtime.runtimeId === active.runtimeId) throw new Error("stop refused");
    });
    const coordinator = new ResidentCoordinator(port, () => crypto.randomUUID());
    await coordinator.mount({
      tabId: "tab-1",
      contribution,
      policy: { appDefault: "on", tab: "inherit" },
      state: {},
      catalogRevision: 0,
    });
    await coordinator.mount({
      tabId: "tab-1",
      contribution: { ...contribution, runtimeKind: "fixture-2" },
      policy: { appDefault: "on", tab: "inherit" },
      state: {},
      catalogRevision: 0,
    });

    await expect(coordinator.stopTab("tab-1")).rejects.toThrow("stop refused");
    expect(port.stop).toHaveBeenCalledTimes(2);
    expect(coordinator.runtime("tab-1", "fixture")).toEqual(active);
    expect(coordinator.runtime("tab-1", "fixture-2")).toBeUndefined();
  });

  it("rejects invalid initial state before descriptor resolution or ensure", async () => {
    const { port } = fixture();
    const resolve = vi.fn(contribution.descriptor);
    const coordinator = new ResidentCoordinator(port);
    await expect(coordinator.mount({
      tabId: "tab-1",
      contribution: { ...contribution, descriptor: resolve },
      policy: { appDefault: "on", tab: "inherit" },
      state: [],
      catalogRevision: 0,
    })).rejects.toThrow("fixture.initial/v1");
    expect(resolve).not.toHaveBeenCalled();
    expect(port.ensure).not.toHaveBeenCalled();
  });
});
