import { expect, test, type Page } from "@playwright/test";

const appSnapshot = {
  version: 1,
  tabs: [
    { id: "terminal", type: "terminal", title: "Build shell", groupId: "work" },
    { id: "browser", type: "browser", title: "Project docs", groupId: "work", url: "https://example.test/docs" },
    { id: "agent", type: "agent", title: "Review agent" },
  ],
  groups: [{ id: "work", name: "Work", colorIndex: 0, collapsed: false }],
  activeTabId: "terminal",
};

async function openReplay(page: Page) {
  await page.goto("?replay");
  await page.waitForFunction(() => typeof (window as Record<string, unknown>).__replayFrame === "function");
  await page.evaluate((snapshot) => {
    const replay = (window as unknown as { __replayFrame: (frame: unknown) => void }).__replayFrame;
    replay({ type: "welcome", proto: 2, tabTitle: "Shared workspace", cols: 80, rows: 24, tabType: "app" });
    replay({ type: "appSnapshot", state: snapshot });
    replay({ type: "mode", readOnly: false });
  }, appSnapshot);
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function replayActions(page: Page) {
  return page.evaluate(() => {
    const replayWindow = window as unknown as Record<string, unknown>;
    return replayWindow.__replayActions as Array<{ name: string; args: unknown }>;
  });
}

test("renders the same replayed app shell across desktop and mobile widths", async ({ page }, testInfo) => {
  await openReplay(page);
  await expect(page.locator("#term")).toBeVisible();

  if (testInfo.project.name === "desktop-chromium") {
    await expect(page.locator(".app-shell-side")).toBeVisible();
    await expect(page.locator(".app-drawer-handle")).toHaveCount(0);
  } else {
    await expect(page.locator(".app-shell-side")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tabs" })).toBeVisible();
    await page.getByRole("button", { name: "Tabs" }).click();
  }

  await expect(page.getByRole("tab", { name: "Build shell" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Project docs" })).toBeVisible();
  const newTab = page.getByRole("button", { name: "New tab" });
  await expect(newTab).toBeVisible();

  await expect(page).toHaveScreenshot("replayed-app-shell.png", {
    animations: "disabled",
    fullPage: true,
    maxDiffPixels: 16,
  });

  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("tab", { name: "Project docs" }).click();
    await expect(page.getByRole("tab", { name: "Project docs" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".browser-pane")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tabs" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Tabs" }).click();
  }

  await newTab.click();
  await expect(page.getByRole("menu", { name: "New tab on the host" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Terminal" }).click();
  await expect(page.getByRole("menu", { name: "New tab on the host" })).toHaveCount(0);

  const expectedActions =
    testInfo.project.name === "mobile-chromium"
      ? [
          { name: "activateTab", args: "browser" },
          { name: "addTab", args: { type: "terminal" } },
        ]
      : [{ name: "addTab", args: { type: "terminal" } }];
  await expect.poll(() => replayActions(page)).toEqual(expectedActions);
});
