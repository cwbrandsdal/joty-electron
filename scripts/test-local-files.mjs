// Uses the sibling web repo's existing Playwright dependency; no real account/API.
/* global window */
import { _electron, expect } from "../../joty-web/node_modules/@playwright/test/index.mjs";
import { MockApi } from "../../joty-web/e2e/mock-api.ts";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "joty-local-files-smoke-"));
const file = path.join(temporary, "Local file sample.md");
await mkdir(path.join(temporary, "other"));
const other = path.join(temporary, "other", "Local file sample.md");
await writeFile(file, "# Local file\r\nOriginal text.\r\n");
await writeFile(other, "Second file\n");
const env = { ...process.env, JOTY_SMOKE_PROFILE: path.join(temporary, "profile") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
  args: [path.join(root, "scripts/fixtures/local-files-main.cjs"), file],
  env,
});
const errors = [];
app.on("window", (page) => page.on("pageerror", (error) => errors.push(error.message)));
try {
  const main = await app.firstWindow();
  main.on("dialog", () => {}); // Electron's will-prevent-unload owns native prompts.
  const api = new MockApi();
  await main.route(/^https?:\/\//, (route) => route.fulfill({ status: 404, body: "" }));
  await api.install(main);
  const editor = main.locator(".cm-content");
  const tabs = main.getByRole("tablist", { name: "Open documents" });
  const fileTab = (filePath) =>
    tabs
      .getByRole("tab")
      .filter({ has: main.locator('[aria-label="Local file"]') })
      .and(main.locator(`[title^=${JSON.stringify(filePath)}]`));
  const answer = (value) =>
    app.evaluate((_, value) => {
      globalThis.testDialogAnswer = value;
    }, value);
  const menu = (group, label) =>
    app.evaluate(
      ({ Menu }, { group, label }) => {
        Menu.getApplicationMenu()
          .items.find((item) => item.label === group)
          .submenu.items.find((item) => item.label === label)
          .click();
      },
      { group, label },
    );
  const open = async (paths) => {
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
    }, paths);
    await main.evaluate(() => window.joty.files.open());
  };
  const context = async (tab, label) => {
    await tab.click({ button: "right" });
    await main.getByRole("menuitem", { name: label, exact: true }).click();
  };
  await expect(editor).toBeVisible();
  await expect(main.getByText(file, { exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "Sign in to copy into Joty" })).toBeVisible();
  expect(app.windows()).toHaveLength(1);
  const id = await main.evaluate(() => window.joty.files.list().then((list) => list.openedId));
  console.log("Testing local Markdown preview and shared view controls.");
  const preview = main.getByRole("region", { name: "Markdown preview", exact: true });
  await expect(preview.getByRole("heading", { name: "Local file" })).toBeVisible();
  await main.getByRole("radio", { name: "Editor", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await menu("View", "Toggle Edit/Preview"); // Editor -> Auto, including signed-out mode.
  await expect(main.getByRole("radio", { name: "Auto", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(preview).toBeVisible();
  const previewFile = path.join(temporary, "preview.txt");
  await writeFile(previewFile, "Plain text\n");
  await open([previewFile]);
  await expect(editor).toContainText("Plain text");
  await expect(preview).toHaveCount(0);
  await main.getByRole("radio", { name: "Split", exact: true }).click();
  await expect(preview).toContainText("Plain text");
  await main.getByRole("radio", { name: "Auto", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await editor.press("Control+End");
  await main.keyboard.type("# Preview test\n**Bold text**\n- [ ] Finish task\n");
  await expect(preview.getByRole("heading", { name: "Preview test" })).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("Bold text");
  await preview.getByRole("checkbox").check();
  await expect(editor).toContainText("- [x] Finish task");
  expect(await readFile(previewFile, "utf8")).toBe("Plain text\n");
  await menu("File", "Save File");
  await expect.poll(() => readFile(previewFile, "utf8")).toContain("- [x] Finish task");
  const divider = main.getByRole("separator", { name: "Resize preview" });
  const box = await divider.boundingBox();
  await main.mouse.move(box.x + box.width / 2, box.y + 30);
  await main.mouse.down();
  await main.mouse.move(box.x + 80, box.y + 30);
  await main.mouse.up();
  await expect
    .poll(() =>
      main.evaluate(() => JSON.parse(localStorage.getItem("joty-editor-prefs")).splitRatio),
    )
    .toBeGreaterThan(0.5);
  await divider.dblclick();
  await expect
    .poll(() =>
      main.evaluate(() => JSON.parse(localStorage.getItem("joty-editor-prefs")).splitRatio),
    )
    .toBe(0.5);
  await menu("Tabs", "Close Tab");
  await expect(fileTab(file)).toHaveAttribute("aria-selected", "true");
  console.log("Testing signed-out tabs, rapid typing and explicit saving.");
  await editor.press("Control+End");
  const extra = "Rapid typing stays local. ".repeat(30);
  await main.keyboard.type(extra);
  const expected = "# Local file\nOriginal text.\n" + extra;
  await expect
    .poll(() => main.evaluate((id) => window.joty.files.get(id).then((doc) => doc.body), id))
    .toBe(expected);
  expect(await readFile(file, "utf8")).toBe("# Local file\r\nOriginal text.\r\n");
  expect(api.requests).toHaveLength(0);
  await expect(fileTab(file).locator('[aria-label="Unsaved changes"]')).toBeVisible();
  await expect(fileTab(file)).toHaveClass(/bg-sky-/);
  await editor.press("Control+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n"));
  await main.keyboard.type("!");
  await menu("File", "Save File");
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n") + "!");
  await editor.press("Backspace");
  await editor.press("Control+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n"));

  await open([file, other]);
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(editor).toHaveText("Second file");
  await editor.press("Control+End");
  await main.keyboard.type("Other draft");
  await fileTab(file).click();
  await expect(editor).toContainText(extra);
  await editor.press("Control+End");
  await main.keyboard.type(" Unsaved copy.");
  await fileTab(other).click();
  await expect(editor).toContainText("Other draft");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("Other draft");
  await editor.press("Control+y");
  await expect(editor).toContainText("Other draft");
  await app.evaluate(
    ({ app }, file) =>
      app.emit("second-instance", {}, [process.execPath, "fixture.cjs", file], process.cwd()),
    file,
  );
  await expect(fileTab(file)).toHaveAttribute("aria-selected", "true");
  expect(app.windows()).toHaveLength(1);
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  expect(
    await main.evaluate(() =>
      window.joty.files.get("not-issued").then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);
  expect(api.requests).toHaveLength(0);

  // A second renderer using the same trusted origin/preload still has no file capability.
  expect(
    await app.evaluate(
      async ({ BrowserWindow }, { id, preload }) => {
        const foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            contextIsolation: true,
            sandbox: true,
          },
        });
        try {
          await foreign.loadURL("app://joty/?capture=1");
          return await foreign.webContents.executeJavaScript(
            `window.joty.files.get(${JSON.stringify(id)}).then(() => false, () => true)`,
          );
        } finally {
          foreign.destroy();
        }
      },
      { id, preload: path.join(root, "electron/preload.cjs") },
    ),
  ).toBe(true);

  console.log("Testing mixed cloud/local tabs and idempotent cloud copy.");
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.testSignedIn = true;
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("joty:auth-state", {
        status: "signed-in",
        user: { id: "file-test-user", email: "test@example.com" },
        error: null,
      });
  });
  await expect(main.getByRole("button", { name: "Copy into Joty", exact: true })).toBeVisible();
  await expect(preview).toBeVisible();
  await menu("View", "Toggle Edit/Preview");
  await expect(main.getByRole("radio", { name: "Split", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await menu("View", "Toggle Edit/Preview");
  await expect(preview).toHaveCount(0);
  await main.getByRole("radio", { name: "Auto", exact: true }).click();
  await expect(preview).toBeVisible();
  const beforeCopy = await readFile(file, "utf8");
  let lostCreate;
  await main.route(
    "**/api/notes",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      lostCreate = route.request().postDataJSON();
      api.upsert(lostCreate);
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await main.getByRole("button", { name: "Copy into Joty", exact: true }).click();
  await expect(main.getByRole("alert")).toContainText("Couldn't copy into Joty");
  await fileTab(other).click();
  await fileTab(file).click();
  await main.getByRole("button", { name: "Copy into Joty", exact: true }).click();
  await expect(main.getByRole("button", { name: "Open Joty copy" })).toBeVisible();
  const copied = [...api.notes.values()].find((note) => note.title === "Local file sample");
  expect(copied?.body).toBe(expected + " Unsaved copy.");
  expect(copied.id).toBe(lostCreate.id);
  expect([...api.notes.values()].filter((note) => note.title === copied.title)).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe(beforeCopy);
  await main.getByRole("button", { name: "Open Joty copy" }).click();
  await expect(main).toHaveURL(new RegExp(`/notes/${copied.id}$`));
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(main.locator(".cm-line")).toHaveText(copied.body.split("\n"));
  const cloudTab = tabs
    .getByRole("tab")
    .filter({ hasNot: main.locator('[aria-label="Local file"]') });
  const persisted = await main.evaluate(() => localStorage.getItem("joty-open-tabs"));
  expect(persisted).not.toContain("local:");
  expect(persisted).not.toContain(temporary);
  expect(api.requests.some((request) => request.path.includes("local:"))).toBe(false);

  // Background local drafts protect bulk close and application quit.
  await answer(2);
  await context(cloudTab, "Close others");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await context(cloudTab, "Close all");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await context(fileTab(file), "Close to the right");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await app.evaluate(({ app }) => app.quit());
  expect(main.isClosed()).toBe(false);
  const mainWindow = await app.browserWindow(main);
  await mainWindow.evaluate((win) => win.close());
  expect(main.isClosed()).toBe(false);
  await fileTab(file).click({ button: "right" });
  await expect(main.getByRole("menuitem", { name: "Archive", exact: true })).toHaveCount(0);
  await expect(main.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
  await main.keyboard.press("Escape");

  console.log("Testing disk conflicts, reload, active-tab close and bulk close.");
  await fileTab(file).click();
  await writeFile(file, "Outside change\r\n");
  await main.getByRole("button", { name: "Save file", exact: true }).click();
  await expect(main.getByRole("alert")).toContainText("changed outside Joty");
  expect(await readFile(file, "utf8")).toBe("Outside change\r\n");
  await answer(0);
  await main.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(main.locator(".cm-line")).toHaveText((expected + " Unsaved copy.").split("\n"));
  await answer(1);
  await main.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(main.locator(".cm-line")).toHaveText(["Outside change", ""]);
  await editor.press("Control+End");
  await main.keyboard.type("Close protection");
  await answer(2);
  await menu("Tabs", "Close Tab");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(editor).toContainText("Close protection");
  await main.screenshot({ path: path.join(temporary, "local-tabs.png") });
  await answer(0);
  await menu("Tabs", "Close Tab");
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(fileTab(other)).toHaveAttribute("aria-selected", "true");
  expect(await readFile(file, "utf8")).toBe("Outside change\r\nClose protection");
  // Discard closes only the selected files; it must not save their drafts.
  await answer(1);
  await context(cloudTab, "Close others");
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(cloudTab).toHaveAttribute("aria-selected", "true");
  expect(await readFile(other, "utf8")).toBe("Second file\n");
  expect(app.windows()).toHaveLength(1);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      screenshot: path.join(temporary, "local-tabs.png"),
      checks:
        "single-window mixed tabs, tint/path/dirty indicator, rapid typing, undo across tabs, Ctrl+S/menu save, same-name files, deduplication, unknown IPC ID, copy retry, no local cloud requests/persistence, conflict/reload, cancel/save/discard and bulk close, background quit protection",
      pageErrors: errors,
    }),
  );
} catch (error) {
  const page = app.windows()[0];
  console.error(
    "Smoke failure state",
    await page
      ?.evaluate(async () => {
        const list = await window.joty.files.list();
        return {
          list,
          files: await Promise.all(list.files.map((file) => window.joty.files.get(file.id))),
        };
      })
      .catch(() => null),
  );
  console.error("Dialogs", await app.evaluate(() => globalThis.testDialogs).catch(() => null));
  throw error;
} finally {
  await app
    .evaluate(() => {
      globalThis.testDialogAnswer = 1;
    })
    .catch(() => {});
  await app.close();
}
