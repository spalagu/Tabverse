/** Build-time constants injected by the vite configs (define). */

/** True in the multi-file Pages build (vite.pages.config.ts), false in the
 * single-file offline build (vite.web.config.ts). Decides service-worker
 * registration and which one-line pitch the gate shows. */
declare const __JOIN_PAGES_BUILD__: boolean;
