import { expect, test } from "@playwright/test";

test("keyboard navigation exposes a visible focus indicator", async ({ page }) => {
  await page.goto("/");

  const newTab = page.getByRole("button", { name: /New tab/ });
  await page.locator("body").click({ position: { x: 2, y: 2 } });

  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    if (await newTab.evaluate((element) => element === document.activeElement)) break;
  }

  await expect(newTab).toBeFocused();
  const focusRing = await newTab.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      color: style.outlineColor,
    };
  });
  expect(focusRing.style).not.toBe("none");
  expect(focusRing.width).toBeGreaterThanOrEqual(2);
  expect(focusRing.color).not.toBe("rgba(0, 0, 0, 0)");
});

test("new-tab menu exposes every workspace entry", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Tabverse");

  await page.getByRole("button", { name: /New tab/ }).click();
  const menu = page.locator(".newtab-menu");
  await expect(menu).toBeVisible();

  for (const label of ["Terminal", "Files", "Browser", "Join remote…", "Settings"]) {
    await expect(menu.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  await menu.getByRole("button", { name: "Terminal", exact: true }).click();
  const activeTerminal = page.locator(".pane:not(.pane-hidden) .term-pane");
  await expect(activeTerminal).toBeVisible();
  await expect(activeTerminal.locator(".term-container")).toBeVisible();
});

test("files rich preview stays inert in the real browser", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const loadedModule = async (suffix: string) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => url.includes(suffix));
      const url = urls.sort().pop();
      if (!url) throw new Error(`loaded module not found: ${suffix}`);
      return import(url);
    };
    const { fsApi } = await loadedModule("/src/backend/fs.ts");
    try {
      await fsApi.create("/demo/security.md", false);
    } catch {
      // A repeated browser run can reuse the in-memory fixture safely.
    }
    await fsApi.write(
      "/demo/security.md",
      [
        "# Safe preview",
        "",
        '<img src="missing.png" onerror="window.__tabverseInjected = true">',
        "",
        '<script>window.__tabverseInjected = true</script>',
        "",
        "[local guide](guide.md)",
      ].join("\n")
    );
    const { useStore } = await loadedModule("/src/state/store.ts");
    const state = useStore.getState();
    const id = state.addTab({ type: "files" });
    useStore.getState().activateTab(id);
  });

  const row = page.locator('.tree-row[title="/demo/security.md"]');
  await expect(row).toBeVisible();
  await row.click();
  const preview = page.locator(".md-view");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Safe preview");
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("img")).not.toHaveAttribute("onerror", /.+/);
  await expect
    .poll(() => page.evaluate(() => "__tabverseInjected" in window))
    .toBe(false);
  await expect
    .poll(() => preview.locator("a").evaluate((link) => link.hasAttribute("href")))
    .toBe(false);
});

test("files text editor edits and saves through the shared Monaco view", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const loadedModule = async (suffix: string) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => url.includes(suffix));
      const url = urls.sort().pop();
      if (!url) throw new Error(`loaded module not found: ${suffix}`);
      return import(url);
    };
    const { fsApi } = await loadedModule("/src/backend/fs.ts");
    try {
      await fsApi.create("/demo/editor.ts", false);
    } catch {
      // A repeated browser run can reuse the in-memory fixture safely.
    }
    await fsApi.write("/demo/editor.ts", "const answer = 42;\n");
    const { useStore } = await loadedModule("/src/state/store.ts");
    const id = useStore.getState().addTab({ type: "files" });
    useStore.getState().activateTab(id);
  });

  await page.locator('.tree-row[title="/demo/editor.ts"]').click();
  const editor = page.locator(
    ".code-editor .modified-in-monaco-diff-editor"
  );
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("const answer = 42;");

  const input = editor.getByRole("textbox");
  await expect(input).toHaveCount(1);
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" // shared");
  await expect(editor.locator(".view-lines")).toContainText(
    "const answer = 42; // shared"
  );
  await expect(input).toBeFocused();
  await page.keyboard.press("ControlOrMeta+S");

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((entry) => entry.includes("/src/backend/fs.ts"))
          .sort()
          .pop();
        if (!url) throw new Error("loaded filesystem module not found");
        const { fsApi } = await import(url);
        return (await fsApi.read("/demo/editor.ts")).text;
      })
    )
    .toBe("const answer = 42; // shared\n");
});

test("files embedded terminal keeps its session and follows cwd", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((entry) => entry.includes("/src/state/store.ts"))
      .sort()
      .pop();
    if (!url) throw new Error("loaded store module not found");
    const { useStore } = await import(url);
    const id = useStore.getState().addTab({ type: "files" });
    useStore.getState().activateTab(id);
  });

  await page.getByTitle(/Open a shell in this directory/).click();
  const panel = page.locator(".file-term-panel");
  const terminal = panel.locator(".file-term-body");
  const input = terminal.locator(".xterm-helper-textarea");
  await expect(panel).toBeVisible();
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("mock shell");

  await page.keyboard.type("session-marker");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("mock: executed session-marker");

  await panel.getByRole("button", { name: "Hide the terminal panel" }).click();
  await expect(panel).toBeHidden();
  await page.getByTitle(/Open a shell in this directory/).click();
  await expect(panel).toBeVisible();
  await expect(terminal).toContainText("mock: executed session-marker");

  await input.focus();
  await page.keyboard.type("cd /tmp");
  await page.keyboard.press("Enter");
  await expect(panel.locator(".file-term-cwd")).toHaveText("/tmp");

  const before = await panel.boundingBox();
  const grip = panel.locator(".file-term-grip");
  const gripBox = await grip.boundingBox();
  if (!before || !gripBox) throw new Error("terminal panel is not measurable");
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y - 50);
  await page.mouse.up();
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before.height + 20);
});
