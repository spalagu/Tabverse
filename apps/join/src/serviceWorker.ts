const CONTROL_TIMEOUT_MS = 10_000;

/**
 * Host-network subresources use the scoped virtual URL handled by sw.ts.
 * Do not mount the Join application until the first page is controlled: an
 * uncontrolled iframe can fetch its HTML through the direct client, but all
 * of its CSS, images and scripts would fall through to GitHub Pages.
 */
export async function waitForHostNetworkWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support the Host-network worker.");
  }

  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller !== null) return;

  await new Promise<void>((resolve, reject) => {
    const controlled = () => {
      if (navigator.serviceWorker.controller === null) return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", controlled);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", controlled);
      reject(new Error("The Host-network worker did not take control of this page."));
    }, CONTROL_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener("controllerchange", controlled);
  });
}
