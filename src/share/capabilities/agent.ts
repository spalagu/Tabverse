import { registerShareCapability } from "../framework/capability";

registerShareCapability("agent", {
  shareable: true,
  levels: ["view", "steer", "approve"],
  defaultLevel: "view",
  payload: "dom",
});
