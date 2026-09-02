import { registerShareCapability } from "../framework/capability";

// Files state is semantic; reads/writes stay host-side behind declared access.
registerShareCapability("files", {
  shareable: true,
  levels: ["view", "steer"],
  defaultLevel: "view",
  payload: "dom",
});
