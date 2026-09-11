import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page, long = false) {
  await page.goto("/");
  await page.getByRole("button", { name: /New tab/ }).waitFor();
  await page.evaluate(async (long) => {
    const url = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((value) => value.includes("/src/state/store.ts")).sort().pop();
    if (!url) throw new Error("Store module has not loaded");
    const { useStore, withPresetGroups } = await import(url);
    const tabs = Array.from({ length: long ? 40 : 4 }, (_, index) => ({
      id: `sidebar-${index}`, type: "files", title: `Workspace ${index + 1}`, renamed: true,
      cwd: "/demo", groupId: !long && index < 2 ? "preset-files" : null,
    }));
    useStore.setState({ tabs, groups: withPresetGroups([]), activeTabId: tabs[0].id,
      selectedTabIds: [], selectionAnchor: null, split: null, draggingTabIds: [],
      contentDrag: null, peekTabId: null, renamingTabId: null, sidebarPinned: true,
      sidebarWidth: 264, sidebarPeeking: false, folderPreviewGroupId: null });
  }, long);
  await expect(page.locator('.sidebar [data-tab-id="sidebar-0"]')).toBeVisible();
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((value) => value.includes("/src/state/store.ts")).sort().pop()!;
    const { useStore } = await import(url);
    const state = useStore.getState();
    return { active: state.activeTabId, selected: state.selectedTabIds,
      dragging: state.draggingTabIds, split: state.split,
      tabs: state.tabs.map((tab: { id: string; groupId: string | null }) => ({ id: tab.id, group: tab.groupId })) };
  });
}

async function startDrag(page: Page, sourceId: string, targetId: string, edge: "before" | "after" | "middle") {
  const source = await page.locator(`[data-tab-id="${sourceId}"] .tab-main`).boundingBox();
  const target = await page.locator(`[data-tab-id="${targetId}"]`).boundingBox();
  if (!source || !target) throw new Error("Drag rows are not visible");
  await page.mouse.move(source.x + 35, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 45, source.y + source.height / 2, { steps: 3 });
  const y = edge === "before" ? target.y + 3 : edge === "after" ? target.y + target.height - 3 : target.y + target.height / 2;
  await page.mouse.move(target.x + 30, y, { steps: 10 });
  // Chromium may need a second movement to deliver its first dragover.
  await page.mouse.move(target.x + 31, y);
}

test("real pointer drag inserts after the last pinned row without activating or changing another folder", async ({ page }) => {
  await seed(page);
  await startDrag(page, "sidebar-2", "sidebar-1", "after");
  await expect(page.locator('[data-tab-id="sidebar-1"]')).toHaveAttribute("data-drop-intent", "after");
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).tabs.filter((tab: { group: string | null }) => tab.group === "preset-files")
    .map((tab: { id: string }) => tab.id)).toEqual(["sidebar-0", "sidebar-1", "sidebar-2"]);
  expect((await snapshot(page)).active).toBe("sidebar-0");
  await expect.poll(async () => (await snapshot(page)).dragging).toEqual([]);
  await expect(page.locator("[data-drop-intent]")).toHaveCount(0);
});

test("middle dwell arms an explicit split and release commits it", async ({ page }) => {
  await seed(page);
  await startDrag(page, "sidebar-2", "sidebar-1", "middle");
  await expect(page.locator('[data-tab-id="sidebar-1"]')).toHaveAttribute("data-drop-intent", "split-left");
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).split?.ids).toEqual(["sidebar-2", "sidebar-1"]);
  await expect(page.locator("[data-drop-intent]")).toHaveCount(0);
});

test("Shift click selects the visible range from a plain click", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Workspace 1", exact: true }).click();
  await page.getByRole("button", { name: "Workspace 4", exact: true }).click({ modifiers: ["Shift"] });
  expect((await snapshot(page)).selected).toEqual(["sidebar-0", "sidebar-1", "sidebar-2", "sidebar-3"]);
  expect((await snapshot(page)).active).toBe("sidebar-0");
});

test("keyboard focus moves without activation; rename can cancel or accept", async ({ page }) => {
  await seed(page);
  const first = page.getByRole("button", { name: "Workspace 1", exact: true });
  const second = page.getByRole("button", { name: "Workspace 2", exact: true });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  expect((await snapshot(page)).active).toBe("sidebar-0");
  await page.keyboard.press("Enter");
  expect((await snapshot(page)).active).toBe("sidebar-1");
  await second.press("F2");
  const rename = page.getByRole("textbox", { name: "Rename tab", exact: true });
  await rename.fill("Discard this name");
  await rename.press("Escape");
  await expect(second).toBeFocused();
  await second.press("F2");
  await rename.fill("项目资料");
  await rename.press("Enter");
  await expect(page.getByRole("button", { name: "项目资料", exact: true })).toBeFocused();
});

test("hover actions do not change title width and keyboard focus remains visible", async ({ page }, testInfo) => {
  await seed(page);
  const target = page.locator('[data-tab-id="sidebar-1"]');
  const title = target.locator(".tab-title");
  await page.mouse.move(700, 100);
  const before = (await title.boundingBox())!.width;
  await target.hover();
  expect((await title.boundingBox())!.width).toBe(before);
  await target.locator(".tab-main").focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { opacity: style.opacity, outline: parseFloat(style.outlineWidth) };
  });
  expect(focused.opacity).toBe("1");
  expect(focused.outline).toBeGreaterThanOrEqual(2);
  await testInfo.attach("sidebar-refined", { body: await page.locator(".sidebar").screenshot(), contentType: "image/png" });
});

test("activating an offscreen tab reveals it without stealing keyboard focus", async ({ page }) => {
  await seed(page, true);
  const search = page.locator(".sidebar-search-btn");
  await search.focus();
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((value) => value.includes("/src/state/store.ts")).sort().pop()!;
    const { useStore } = await import(url);
    useStore.getState().activateTab("sidebar-39");
  });
  await expect(page.locator('[data-tab-id="sidebar-39"]')).toBeInViewport();
  await expect(page.locator('[data-tab-id="sidebar-39"] .tab-main')).not.toBeFocused();
});

test("closing a pinned tab still shelves it and clicking wakes it", async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-tab-id="sidebar-0"]');
  await row.locator(".tab-close").click();
  await expect(row).toHaveClass(/dormant/);
  await expect(row.locator(".tab-close")).toHaveCount(0);
  await row.locator(".tab-main").click();
  await expect(row).not.toHaveClass(/dormant/);
  expect((await snapshot(page)).active).toBe("sidebar-0");
});
