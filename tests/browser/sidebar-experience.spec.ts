import { expect, test, type Page } from "@playwright/test";
async function state(page: Page, action = "snapshot", value?: unknown) {
  return page.evaluate(async ({ action, value }) => {
    // The desktop Vite root is apps/desktop, so shared renderer modules are
    // served through /@fs. Reuse the loaded store URL without its HMR query.
    const loadedUrl = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/src/state/store.ts"));
    if (!loadedUrl) throw new Error("Store module did not load");
    const moduleUrl = new URL(loadedUrl); moduleUrl.search = "";
    const { useStore, withPresetGroups } = await import(moduleUrl.href);
    if (action === "seed") {
      const count = typeof value === "number" ? value : 5;
      const tabs = Array.from({ length: count }, (_, i) => ({ id: `ux-${i}`, type: "files", title: i === 1 ? "Architecture and implementation notes" : `Workspace ${i + 1}`, renamed: true, cwd: "/demo", groupId: i < 2 ? "preset-files" : null }));
      useStore.setState({ tabs, groups: withPresetGroups([]), activeTabId: "ux-0", split: null, selectedTabIds: [], selectionAnchor: null, renamingTabId: null, menu: null, groupMenu: null, sidebarPinned: true, sidebarPeeking: false, sidebarClosing: false, sidebarWidth: 264, folderPreviewGroupId: null, peekTabId: null, draggingTabIds: [], contentDrag: null });
    } else if (action === "activate") useStore.getState().activateTab(value);
    else if (action === "floating") useStore.setState({ sidebarPinned: false, sidebarPeeking: false, sidebarClosing: false });
    else if (action === "reopen") useStore.getState().reopenClosedTab();
    else if (action === "split") useStore.getState().splitWith(value);
    else if (action === "unsplit") useStore.getState().unsplit();
    else if (action === "theme") useStore.setState({ theme: value, resolvedTheme: value });
    else if (action === "width") useStore.setState({ sidebarWidth: value });
    const s = useStore.getState();
    return { active: s.activeTabId, shown: s.sidebarPeeking, closing: s.sidebarClosing, selected: s.selectedTabIds, dragging: s.draggingTabIds, split: s.split, tabs: s.tabs.map((t: { id: string; groupId: string | null; dormant?: boolean }) => ({ id: t.id, group: t.groupId, dormant: t.dormant === true })) };
  }, { action, value });
}
async function seed(page: Page, count = 5) {
  await page.goto("/"); await page.getByRole("button", { name: /New tab/ }).waitFor();
  await state(page, "seed", count); await expect(page.locator('[data-tab-id="ux-0"]')).toBeVisible();
}
const row = (page: Page, id: number) => page.locator(`.sidebar [data-tab-id="ux-${id}"]`);
async function startDrag(page: Page, source: number, target: number, fraction = 0.9) {
  const from = await row(page, source).locator(".tab-main").boundingBox(); const to = await row(page, target).boundingBox();
  if (!from || !to) throw new Error("Drag targets missing");
  await page.mouse.move(from.x + 30, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + 50, to.y + to.height * fraction, { steps: 10 });
  await page.mouse.move(to.x + 51, to.y + to.height * fraction);
}
test("C04: real lower-edge drag inserts after, keeps current content and clears all feedback", async ({ page }) => {
  await seed(page); await startDrag(page, 2, 1);
  await expect(row(page, 1)).toHaveAttribute("data-drop-intent", "after"); await page.mouse.up();
  await expect.poll(async () => (await state(page)).tabs.filter((t: { group: string | null }) => t.group === "preset-files").map((t: { id: string }) => t.id)).toEqual(["ux-0", "ux-1", "ux-2"]);
  expect((await state(page)).active).toBe("ux-0"); await expect(page.locator("[data-drop-intent]")).toHaveCount(0);
  expect((await state(page)).dragging).toEqual([]);
});
test("C04: dwelling over a row never changes a sort into split", async ({ page }) => {
  await seed(page); await startDrag(page, 2, 1, 0.55); await page.waitForTimeout(650);
  await expect(row(page, 1)).toHaveAttribute("data-drop-intent", "after"); await page.mouse.up(); expect((await state(page)).split).toBeNull();
});
test("A03/C06: split entries remain fully readable in their own groups and unsplit preserves both", async ({ page }) => {
  await seed(page); await row(page, 2).locator(".tab-main").click({ button: "right" });
  await page.getByRole("button", { name: "Split with active tab", exact: true }).click();
  await expect(row(page, 0).locator(".tab-split-mark")).toBeVisible(); await expect(row(page, 2).locator(".tab-split-mark")).toBeVisible();
  expect((await state(page)).tabs.find((t: { id: string }) => t.id === "ux-2")?.group).toBeNull();
  await row(page, 2).locator(".tab-main").click({ button: "right" });
  await page.getByRole("button", { name: "Separate split into tabs", exact: true }).click();
  expect((await state(page)).split).toBeNull(); expect((await state(page)).tabs).toHaveLength(5);
  expect((await state(page)).tabs[0].group).toBe("preset-files"); expect((await state(page)).tabs[2].group).toBeNull();
});
test("A01: a dormant pin removes directly and restores dormant without a Today copy", async ({ page }) => {
  await seed(page); await row(page, 0).locator(".tab-close").click(); await expect(row(page, 0)).toHaveClass(/dormant/);
  await row(page, 0).hover(); await row(page, 0).getByRole("button", { name: "Remove saved tab", exact: true }).click();
  await expect(row(page, 0)).toHaveCount(0); expect((await state(page)).tabs).toHaveLength(4);
  const active = (await state(page)).active; await state(page, "reopen");
  await expect(row(page, 0)).toHaveClass(/dormant/); expect((await state(page)).active).toBe(active);
  expect((await state(page)).tabs.filter((t: { id: string }) => t.id === "ux-0")).toEqual([{ id: "ux-0", group: "preset-files", dormant: true }]);
});
test("C02/C03: keyboard focus, rename cancellation and Shift range are independent of activation", async ({ page }) => {
  await seed(page); await row(page, 0).locator(".tab-main").focus(); await page.keyboard.press("ArrowDown");
  await expect(row(page, 1).locator(".tab-main")).toBeFocused(); expect((await state(page)).active).toBe("ux-0");
  await page.keyboard.press("Enter"); expect((await state(page)).active).toBe("ux-1"); await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Rename tab", exact: true }); await input.fill("Discarded title"); await input.press("Escape");
  await expect(row(page, 1).locator(".tab-main")).toBeFocused(); await page.keyboard.press("F2"); await input.fill("Project documentation"); await input.press("Enter");
  await expect(row(page, 1).locator(".tab-main")).toHaveAccessibleName("Project documentation");
  await row(page, 0).locator(".tab-main").click(); await row(page, 3).locator(".tab-main").click({ modifiers: ["Shift"] });
  expect((await state(page)).selected).toEqual(["ux-0", "ux-1", "ux-2", "ux-3"]); expect((await state(page)).active).toBe("ux-0");
});
test("C07/C09: hover keeps title width stable and a bottom-edge menu fits the viewport", async ({ page }, info) => {
  await seed(page); const title = row(page, 1).locator(".tab-title"); await page.mouse.move(900, 100);
  const before = (await title.boundingBox())!.width; await row(page, 1).hover(); expect((await title.boundingBox())!.width).toBe(before);
  await state(page, "width", 220); await expect(row(page, 1).locator(".tab-close")).toBeVisible();
  await page.evaluate(async () => {
    const loadedUrl = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/src/state/store.ts"));
    if (!loadedUrl) throw new Error("Store module did not load");
    const moduleUrl = new URL(loadedUrl); moduleUrl.search = "";
    const { useStore } = await import(moduleUrl.href); useStore.getState().openMenu("ux-1", innerWidth - 20, innerHeight - 20);
  });
  const menu = page.locator(".sidebar-context-menu"); await expect(menu).toBeVisible(); const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(7); expect(box.y).toBeGreaterThanOrEqual(7); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape"); await info.attach("sidebar-layout", { body: await page.locator(".sidebar").screenshot(), contentType: "image/png" });
});
test("B02/B03: edge needs intent, closing has grace, and returning cancels the exit", async ({ page }) => {
  await seed(page); await page.mouse.move(700, 300); await page.locator(".tab-main").first().evaluate((e) => (e as HTMLElement).blur()); await state(page, "floating");
  await page.mouse.move(1, 350); await page.mouse.move(700, 350); await page.waitForTimeout(200); expect((await state(page)).shown).toBe(false);
  await page.mouse.move(1, 350); await expect.poll(async () => (await state(page)).shown).toBe(true); await page.mouse.move(100, 350); await page.waitForTimeout(250);
  await page.mouse.move(700, 350); expect((await state(page)).shown).toBe(true); await page.waitForTimeout(150); await page.mouse.move(100, 350);
  await page.waitForTimeout(450); expect((await state(page)).shown).toBe(true); expect((await state(page)).closing).toBe(false);
  await page.mouse.move(700, 350); await expect.poll(async () => (await state(page)).closing).toBe(true); expect((await state(page)).shown).toBe(true);
  await expect.poll(async () => (await state(page)).shown).toBe(false); await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
});
test("C08: an offscreen activation reveals its row without moving keyboard focus into it", async ({ page }) => {
  await seed(page, 40); const search = page.locator(".sidebar-search-btn"); await search.focus(); await state(page, "activate", "ux-39");
  await expect(row(page, 39)).toBeInViewport(); await expect(row(page, 39).locator(".tab-main")).not.toBeFocused();
});
