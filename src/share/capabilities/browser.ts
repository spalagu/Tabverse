import { registerShareCapability } from "../framework/capability";

// Ruled out for good, not merely unbuilt: sharing a browser tab is sharing
// a picture of a page, and picture-class sharing was rejected in the
// remote-control capability contract.
registerShareCapability("browser", {
  shareable: false,
  reason: "browser tabs cannot be shared",
});
