export * from "./appShare";
export * from "./remote";

/** Shared facts that every Tabverse renderer may depend on. This package is
 * deliberately free of React, Tauri, browser globals and transport code. */
/** Tab kind ownership belongs to enabled TabContributions. */
export type TabType = string;
