import { registerShareCapability } from "../framework/capability";

registerShareCapability("settings", {
  shareable: false,
  reason: "settings tabs cannot be shared",
});
