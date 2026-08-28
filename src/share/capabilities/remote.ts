import { registerShareCapability } from "../framework/capability";

// A remote tab is the viewing end of somebody else's share; re-sharing it
// would chain relays around the host's own ticket and access control.
registerShareCapability("remote", {
  shareable: false,
  reason: "a remote tab is already someone else's share",
});
