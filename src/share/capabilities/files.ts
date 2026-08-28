import { registerShareCapability } from "../framework/capability";

// No runtime to mirror: a files tab is a local view over the filesystem,
// with no event stream a viewer could follow.
registerShareCapability("files", {
  shareable: false,
  reason: "files tabs cannot be shared",
});
