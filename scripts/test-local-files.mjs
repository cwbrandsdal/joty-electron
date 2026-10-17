// Uses the sibling web repo's existing Playwright dependency; no real account/API.
/* global window */
import { _electron, expect } from "../../joty-web/node_modules/@playwright/test/index.mjs";
import { MockApi } from "../../joty-web/e2e/mock-api.ts";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "joty-local-files-smoke-"));
const file = path.join(temporary, "Local file sample.md");
await writeFile(file, "# Local file\r\nOriginal text.\r\n");
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
  await expect.poll(() => app.windows().length).toBe(2);
  const local = app.windows().find((page) => page.url().includes("localFile"));
  const main = app.windows().find((page) => page !== local);
  // Electron's will-prevent-unload handler owns this prompt, not Playwright.
  local.on("dialog", () => {});
  const api = new MockApi();
  await main.route(/^https?:\/\//, (route) => route.fulfill({ status: 404, body: "" }));
  await local.route(/^https?:\/\//, (route) => route.fulfill({ status: 404, body: "" }));
  await api.install(main);
  await api.install(local);
  const editor = local.locator(".cm-content");
  await expect(editor).toBeVisible();
  await expect(local.getByText("Local file", { exact: true })).toBeVisible();
  await expect(local.getByText(file, { exact: true })).toBeVisible();
  await expect(local.getByRole("button", { name: "Sign in to copy into Joty" })).toBeVisible();
  await local.bringToFront();
  console.log("Local file opened; testing typing and save.");
  await editor.click();
  await editor.press("Control+End");
  const extra = "Rapid typing stays local. ".repeat(30);
  await local.keyboard.type(extra);
  const expected = "# Local file\nOriginal text.\n" + extra;
  await expect
    .poll(() => local.evaluate(() => window.joty.files.get().then((doc) => doc.body)))
    .toBe(expected);
  expect(await readFile(file, "utf8")).toBe("# Local file\r\nOriginal text.\r\n");
  expect(api.requests).toHaveLength(0);
  await editor.press("Control+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n"));
  await expect(local.getByText("Saved on this computer · Ctrl+S to save edits")).toBeVisible();

  // Exercise the native File menu's save request, including the latest keystroke.
  await local.keyboard.type("!");
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      .items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Save File")
      .click();
  });
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n") + "!");
  await editor.press("Backspace");
  await editor.press("Control+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(expected.replaceAll("\n", "\r\n"));

  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await local.getByRole("button", { name: "Open file…", exact: true }).click();
  expect(app.windows()).toHaveLength(2);

  // The same Windows Open-with request focuses the existing file window.
  await app.evaluate(
    ({ app }, file) =>
      app.emit("second-instance", {}, [process.execPath, "fixture.cjs", file], process.cwd()),
    file,
  );
  expect(app.windows()).toHaveLength(2);
  // A notes window cannot read the file even though it shares the preload.
  expect(
    await main.evaluate(() =>
      window.joty.files.get().then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);

  await editor.press("Control+End");
  await local.keyboard.type(" Unsaved copy.");
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.testSignedIn = true;
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("joty:auth-state", {
        status: "signed-in",
        user: { id: "file-test-user", email: "test@example.com" },
        error: null,
      });
  });
  const beforeCopy = await readFile(file, "utf8");
  // Simulate a create that reached the server but whose response was lost.
  let lostCreate;
  await local.route(
    "**/api/notes",
    (route) => {
      lostCreate = route.request().postDataJSON();
      api.upsert(lostCreate);
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await local.getByRole("button", { name: "Copy into Joty", exact: true }).click();
  await expect(local.getByRole("alert")).toContainText("Couldn't copy into Joty");
  await local.getByRole("button", { name: "Copy into Joty", exact: true }).click();
  await expect(local.getByRole("button", { name: "Open Joty copy" })).toBeVisible();
  const copied = [...api.notes.values()].find((note) => note.title === "Local file sample");
  expect(copied?.body).toBe(expected + " Unsaved copy.");
  expect(copied.id).toBe(lostCreate.id);
  expect([...api.notes.values()].filter((note) => note.title === "Local file sample")).toHaveLength(
    1,
  );
  expect(await readFile(file, "utf8")).toBe(beforeCopy);
  await local.getByRole("button", { name: "Open Joty copy" }).click();
  await expect(main).toHaveURL(new RegExp(`/notes/${copied.id}$`));
  await expect(main.locator(".cm-line")).toHaveText(copied.body.split("\n"));

  // An external write must remain untouched; the local draft is still recoverable.
  await writeFile(file, "Outside change\r\n");
  await local.getByRole("button", { name: "Save file", exact: true }).click();
  await expect(local.getByRole("alert")).toContainText("changed outside Joty");
  expect(await readFile(file, "utf8")).toBe("Outside change\r\n");
  await app.evaluate(() => {
    globalThis.testDialogAnswer = 0;
  });
  await local.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(local.locator(".cm-line")).toHaveText((expected + " Unsaved copy.").split("\n"));
  await app.evaluate(() => {
    globalThis.testDialogAnswer = 1;
  });
  await local.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(local.locator(".cm-line")).toHaveText(["Outside change", ""]);

  await editor.click();
  await editor.press("Control+End");
  await local.keyboard.type("Close protection");
  await app.evaluate(() => {
    globalThis.testDialogAnswer = 2;
  });
  const localWindow = await app.browserWindow(local);
  await localWindow.evaluate((win) => win.close());
  await expect.poll(() => app.evaluate(() => globalThis.testDialogs.length)).toBeGreaterThan(2);
  expect(local.isClosed()).toBe(false);
  await expect(editor).toContainText("Close protection");
  // Cancel quit must keep every window open too.
  await app.evaluate(({ app }) => app.quit());
  expect(local.isClosed()).toBe(false);
  expect(main.isClosed()).toBe(false);
  await local.screenshot({ path: path.join(temporary, "local-file.png") });
  await app.evaluate(() => {
    globalThis.testDialogAnswer = 0;
  });
  await localWindow.evaluate((win) => win.close());
  await expect.poll(() => local.isClosed()).toBe(true);
  expect(await readFile(file, "utf8")).toBe("Outside change\r\nClose protection");
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      screenshot: path.join(temporary, "local-file.png"),
      checks:
        "signed-out opening, rapid typing, Ctrl+S, IPC ownership, duplicate open, explicit cloud copy, external conflict, reload, close and quit protection",
      pageErrors: errors,
    }),
  );
} finally {
  await app
    .evaluate(() => {
      globalThis.testDialogAnswer = 1;
    })
    .catch(() => {});
  await app.close();
}
