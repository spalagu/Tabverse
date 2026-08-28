/**
 * Desktop compatibility adapter for the shared Workbench theme source.
 * Theme derivation and token data live in packages/workbench; only desktop
 * diagnostics are injected here because the shared package has no Tauri
 * dependency.
 */
import { setUnknownThemeReporter } from "@tabverse/workbench/theme";
import { coreLog } from "../errlog";

setUnknownThemeReporter((theme, fallback) => {
  coreLog("warn", `unknown theme ${JSON.stringify(theme)} — falling back to ${fallback}`);
});

export * from "@tabverse/workbench/theme";
