import { describe, expect, it } from "vitest";
import { classifyRemote, shortHost } from "./remoteState";

describe("classifyRemote", () => {
  it.each([
    ["ssh prod.example.com", "prod.example.com"],
    ["ssh -p 2222 user@10.0.0.5", "10.0.0.5"],
    ["ssh -p2222 glue.example.com", "glue.example.com"], // glued value form
    ["ssh -i ~/.ssh/id_ed25519 -t deploy@bastion", "bastion"],
    ["ssh -tt -4 web-01.example.com", "web-01.example.com"],
    ["ssh -J jump@bastion.corp internal.local", "internal.local"],
    ["ssh -o BatchMode=yes ops@ops.internal", "ops.internal"],
    ["mosh user@irons.lan", "irons.lan"],
    ["telnet router.local 2323", "router.local"],
    // system opens arrive quoted (system_open.rs's shell_quote).
    ["ssh -p 22 'user@host.lan'", "host.lan"],
    // An env prefix is not a command word; the first command is still ssh.
    ["FOO=1 ssh build.example.com", "build.example.com"],
  ])("%s → remote on %s", (command, host) => {
    expect(classifyRemote(command)).toEqual({ host });
  });

  it.each([
    // The explicit negative: scp names a remote file, it does not put the
    // pane inside the remote host.
    "scp report.txt server.example.com:",
    "scp -P 22 server.example.com:/var/log/app.log .",
    "ls -la",
    "echo ssh",
    "grep ssh ~/.zshrc",
    // ssh-prefixed words are not the ssh command.
    "ssh-keygen -t ed25519",
    "ssh-add -l",
    "echo hi && ssh host.example.com",
    "make || ssh host.example.com",
    // An assignment-only line has no command word at all.
    "FOO=1",
    // ssh-family with nothing after the flags: no target, no host.
    "ssh -p 2222",
    "",
  ])("%s → not remote", (command) => {
    expect(classifyRemote(command)).toBeNull();
  });
});

describe("shortHost", () => {
  it("keeps the first label of a domain", () => {
    expect(shortHost("web-01.example.com")).toBe("web-01");
  });
  it("keeps a dotless host whole", () => {
    expect(shortHost("irons")).toBe("irons");
    expect(shortHost("10.0.0.5")).toBe("10"); // an IP's first label — short on purpose
  });
});
