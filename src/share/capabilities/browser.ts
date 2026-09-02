import { registerShareCapability } from "../framework/capability";

// Semantic state plus host-network requests; never a picture/video stream.
registerShareCapability("browser", {
  shareable: true,
  levels: ["view", "steer"],
  defaultLevel: "steer",
  payload: "dom",
});
