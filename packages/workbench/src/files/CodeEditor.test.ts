import { describe, expect, it } from "vitest";
import { languageFor } from "./editorLanguage";

describe("shared code editor language mapping", () => {
  it("maps compound and case-insensitive filenames", () => {
    expect(languageFor("/workspace/Dockerfile.dev")).toBe("dockerfile");
    expect(languageFor("/workspace/MAKEFILE.local")).toBe("makefile");
  });

  it("maps source extensions without depending on a desktop runtime", () => {
    expect(languageFor("/workspace/App.tsx")).toBe("typescript");
    expect(languageFor("/workspace/main.rs")).toBe("rust");
    expect(languageFor("/workspace/config.yaml")).toBe("yaml");
  });

  it("uses plaintext for extensionless and unknown files", () => {
    expect(languageFor("/workspace/README")).toBe("plaintext");
    expect(languageFor("/workspace/data.unknown")).toBe("plaintext");
  });
});
