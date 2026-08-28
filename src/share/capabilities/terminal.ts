import { registerShareCapability } from "../framework/capability";

// Two levels, not three: Approve adds nothing over Steer at a terminal —
// may_steer already covers every byte of input, and there is nothing to
// approve. Cutting it also means the two levels are exactly what the v1
// wire's read_only bool can express, so v1 viewers lose nothing.
registerShareCapability("terminal", {
  shareable: true,
  levels: ["view", "steer"],
  defaultLevel: "steer",
  payload: "grid",
});
