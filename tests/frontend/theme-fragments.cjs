// Theme checks use the real App with mocked APIs; no acceptance data is touched.
const { createBrowserSession } = require("./browser-session.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const baseUrl = process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173";
const key = "video-annotation-theme";
const clip = fs.readFileSync(path.join(root, "storage/videos/pusht-demo.mp4"));
const output = process.env.TEST_ARTIFACT_DIR || path.join(root, ".cache/theme");
fs.mkdirSync(output, { recursive: true });

(async () => {
  const session = await createBrowserSession("theme", {
    width: 1600,
    height: 1050,
  });
  const { context, page, browser } = session;
  let loggedIn = false;
  let admin = false;
  const errors = [];
  const businessWrites = [];
  const task = {
    id: "theme-task",
    title: "推方块示教 04",
    tenant_id: "theme-tenant",
    tenant_name: "租户 A",
    duration_ms: 138000,
    status: "in_progress",
    assignee_id: "theme-a1",
    assignee_name: "标注员 A1",
    created_at: "2026-10-23T01:00:00Z",
    submitted_at: null,
    revision: 7,
    segments: [
      { start_ms: 5000, end_ms: 12500 },
      { start_ms: 25000, end_ms: 38000 },
      { start_ms: 48000, end_ms: 65500 },
      { start_ms: 79000, end_ms: 89000 },
    ],
    effective_ms: 48000,
  };
  const identity = () => ({
    user: {
      id: admin ? "theme-admin" : "theme-a1",
      username: admin ? "admin" : "a1",
      display_name: admin ? "管理员" : "标注员 A1",
      role: admin ? "admin" : "annotator",
      tenant_id: admin ? null : "theme-tenant",
      tenant_name: admin ? null : "租户 A",
    },
    csrf_token: "mock-only",
  });
  const mock = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/stats/me")
      return route.fulfill({
        json: {
          timezone: "Asia/Shanghai",
          start_date: "2025-10-24",
          end_date: "2026-10-23",
          task_count: 0,
          effective_ms: 0,
          today_count: 0,
          active_days: 0,
          items: [],
        },
      });
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        status: loggedIn ? 200 : 401,
        json: loggedIn ? identity() : { detail: "请先登录" },
      });
    if (url.pathname === "/api/auth/login") {
      loggedIn = true;
      return route.fulfill({ json: identity() });
    }
    if (url.pathname === "/api/auth/logout") {
      loggedIn = false;
      return route.fulfill({ status: 204 });
    }
    if (req.method() !== "GET") {
      businessWrites.push(url.pathname);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/tasks")
      return route.fulfill({
        json: { items: [task], total: 1, page: 1, page_size: 10 },
      });
    if (url.pathname === "/api/tasks/theme-task")
      return route.fulfill({ json: task });
    if (url.pathname.endsWith("/frames"))
      return route.fulfill({
        json: {
          frame_times_ms: Array.from({ length: 3451 }, (_, i) => i * 40),
        },
      });
    if (url.pathname.endsWith("/video")) {
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers().range || "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2]
        ? Math.min(Number(match[2]), clip.length - 1)
        : clip.length - 1;
      return route.fulfill({
        status: match ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          ...(match
            ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` }
            : {}),
        },
        body: clip.subarray(start, end + 1),
      });
    }
    if (url.pathname === "/api/tenants")
      return route.fulfill({ json: [{ id: "theme-tenant", name: "租户 A" }] });
    if (url.pathname === "/api/stats/daily")
      return route.fulfill({
        json: {
          timezone: "Asia/Shanghai",
          start_date: url.searchParams.get("start_date"),
          end_date: url.searchParams.get("end_date"),
          task_count: 0,
          effective_ms: 0,
          items: [],
        },
      });
    throw new Error(`Unexpected theme mock ${url.pathname}`);
  };
  await context.route("**/api/**", mock);
  page.on("pageerror", (error) => errors.push(error.message));
  const checkTheme = async (target, theme) => {
    await target.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      theme,
    );
    assert.equal(
      await target
        .locator("html")
        .evaluate((el) => getComputedStyle(el).colorScheme),
      theme,
    );
    assert.equal(
      await target
        .getByRole("button", {
          name: theme === "light" ? "浅色模式" : "深色模式",
          exact: true,
        })
        .first()
        .getAttribute("aria-pressed"),
      "true",
    );
  };
  const screenshot = (name) =>
    page.screenshot({
      path: path.join(output, name),
      fullPage: true,
      animations: "disabled",
    });
  const noOverflow = async () =>
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No whole-page horizontal overflow",
    );
  try {
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "登录工作区" }).waitFor();
    await checkTheme(page, "dark");
    await page.getByRole("button", { name: "浅色模式", exact: true }).click();
    await checkTheme(page, "light");
    assert.equal(
      await page.evaluate((k) => localStorage.getItem(k), key),
      "light",
    );
    await screenshot("login-light.png");
    await page.reload();
    await page.getByRole("heading", { name: "登录工作区" }).waitFor();
    await checkTheme(page, "light");
    await page.getByLabel("账号", { exact: true }).fill("a1");
    await page.getByLabel("密码", { exact: true }).fill("mock-only");
    await page.getByRole("button", { name: "进入工作区" }).click();
    await page.getByRole("heading", { name: "我的任务" }).waitFor();
    await checkTheme(page, "light");
    await screenshot("tasks-light.png");

    const second = await context.newPage();
    await second.goto(baseUrl);
    await second.getByRole("heading", { name: "我的任务" }).waitFor();
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await checkTheme(second, "dark");
    await second.getByRole("button", { name: "浅色模式", exact: true }).click();
    await checkTheme(page, "light");
    await second.close();

    await page.getByRole("button", { name: "我的任务", exact: true }).click();
    await page.locator(".task-title").first().click();
    await page
      .getByRole("heading", { name: task.title, exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    await page.getByRole("button", { name: "片段 2", exact: true }).click();
    await page.locator("video").evaluate((v) => {
      v.pause();
      v.currentTime = 32.4;
    });
    await screenshot("workspace-light.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("workspace-mobile-light.png");
    await page.setViewportSize({ width: 1600, height: 1050 });
    const row = page.getByLabel("片段 2 起点", { exact: true });
    await row.fill("10");
    await row.blur();
    assert.equal(await row.getAttribute("aria-invalid"), "true");
    await screenshot("workspace-error-light.png");
    await row.fill("26");
    await row.blur();
    const player = page.locator("video");
    const selectedLabel = await page
      .locator(".segment-row.selected .segment-select")
      .textContent();
    const currentTime = await player.evaluate((v) => v.currentTime);
    const darkButton = page.getByRole("button", {
      name: "深色模式",
      exact: true,
    });
    await darkButton.focus();
    await darkButton.press("Space");
    await checkTheme(page, "dark");
    assert.equal(
      await player.evaluate((v) => v.paused),
      true,
      "Theme keyboard control must not play the video",
    );
    await darkButton.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => v.currentTime),
      currentTime,
      "Theme focus must not seek video",
    );
    await screenshot("workspace-dark.png");
    await page
      .getByRole("button", { name: "浅色模式", exact: true })
      .press("Enter");
    await checkTheme(page, "light");
    assert.equal(
      await row.inputValue(),
      "26",
      "Unsaved edits survive theme changes",
    );
    assert.equal(
      await page.locator(".segment-row.selected .segment-select").textContent(),
      selectedLabel,
    );
    await page.getByRole("button", { name: "全屏播放", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    const full = page.locator(".player-workspace");
    await full.getByRole("button", { name: "深色模式", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await full.getByRole("button", { name: "浅色模式", exact: true }).click();
    await screenshot("fullscreen-light.png");
    await full.getByRole("button", { name: "退出全屏", exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await row.inputValue(), "26");
    assert.equal(await player.evaluate((v) => v.currentTime), currentTime);
    assert.deepEqual(
      businessWrites,
      [],
      "Theme changes never save or submit edits",
    );
    // Return to the original value so navigation below never discards user edits.
    await row.fill("25");
    await row.blur();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("heading", { name: "登录工作区" }).waitFor();
    await checkTheme(page, "light");

    // Simulate a fresh browser session with persisted site storage.
    const reopened = await browser.newContext({
      storageState: await context.storageState(),
    });
    await reopened.route("**/api/**", mock);
    const reopenedPage = await reopened.newPage();
    await reopenedPage.goto(baseUrl);
    await reopenedPage.getByRole("heading", { name: "登录工作区" }).waitFor();
    await checkTheme(reopenedPage, "light");
    await reopened.close();

    admin = true;
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("mock-only");
    await page.getByRole("button", { name: "进入工作区" }).click();
    await page.getByRole("heading", { name: "所有任务" }).waitFor();
    const sidebarWidth = async () =>
      Math.round((await page.locator(".sidebar").boundingBox()).width);
    assert.equal(await sidebarWidth(), 70);
    assert.equal(await page.locator(".task-navigation").count(), 0);
    await screenshot("admin-collapsed-light.png");
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 220);
    await page.getByRole("button", { name: "任务管理", exact: true }).click();
    assert.equal(
      await sidebarWidth(),
      220,
      "Admin navigation does not toggle sidebar expansion",
    );
    await screenshot("admin-expanded-light.png");
    await page.getByRole("button", { name: "发布任务", exact: true }).click();
    await page
      .getByRole("heading", { name: "发布任务", exact: true })
      .waitFor();
    assert.equal(await sidebarWidth(), 220);
    await page.locator('input[type="file"]').setInputFiles({
      name: "主题验收.mp4",
      mimeType: "video/mp4",
      buffer: clip,
    });
    const publishTitle = page.getByRole("button", {
      name: "编辑任务 1 标题",
      exact: true,
    });
    await publishTitle.click();
    const titleInput = page.getByLabel("任务 1 标题", { exact: true });
    await titleInput.fill("未保存的发布标题");
    await titleInput.press("Enter");
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 70);
    assert.equal(await publishTitle.innerText(), "未保存的发布标题");
    await page
      .getByRole("button", { name: "展开侧栏", exact: true })
      .press("Enter");
    assert.equal(await sidebarWidth(), 220);
    assert.equal(await publishTitle.innerText(), "未保存的发布标题");
    await checkTheme(page, "light");
    await screenshot("publish-light.png");
    await page
      .getByRole("button", { name: "移除 主题验收.mp4", exact: true })
      .click();
    await page.getByRole("button", { name: "每日统计", exact: true }).click();
    await page.getByRole("heading", { name: "每日有效时长" }).waitFor();
    assert.equal(await sidebarWidth(), 220);
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.getByRole("button", { name: "任务管理", exact: true }).click();
    await page.getByRole("heading", { name: "所有任务" }).waitFor();
    assert.equal(await sidebarWidth(), 70);
    await page.locator(".task-title").first().click();
    await page
      .getByRole("heading", { name: task.title, exact: true })
      .waitFor();
    assert.equal(await sidebarWidth(), 70);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 220);
    assert.equal(
      await page.getByLabel("片段 1 起点", { exact: true }).count(),
      0,
      "Admin detail stays read-only",
    );
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    await screenshot("admin-editor-light.png");
    await page
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    await page.getByRole("button", { name: "每日统计", exact: true }).click();
    await page.getByRole("heading", { name: "每日有效时长" }).waitFor();
    await checkTheme(page, "light");
    await screenshot("statistics-light.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("mobile-light.png");
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    assert.equal(
      await page.locator(".sidebar .nav-item > span").first().isVisible(),
      false,
    );
    await noOverflow();
    await screenshot("admin-mobile-collapsed-light.png");
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(
      await page.locator(".sidebar .nav-item > span").first().isVisible(),
      true,
    );
    await noOverflow();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("heading", { name: "登录工作区" }).waitFor();
    await noOverflow();

    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "video-annotation-theme")
          throw new DOMException("Mock storage denied", "SecurityError");
        return original.call(this, key, value);
      };
    });
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await checkTheme(page, "dark");
    await page.getByText("已切换，浏览器暂时无法记住主题。").waitFor();
    await noOverflow();
    assert.deepEqual(errors, []);
    assert.deepEqual(businessWrites, []);
    console.log(
      "Theme checks passed: page coverage, local persistence, cross-tab sync, logout/login, new browser session, fullscreen, preserved edits/playhead, keyboard, mobile, storage failure.",
    );
  } catch (error) {
    await session.captureFailure(error);
    throw error;
  } finally {
    await session.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
