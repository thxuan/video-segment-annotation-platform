// Focused component checks with mocked APIs; never contact the acceptance database.
// Set PLAYWRIGHT_MODULE_PATH if Playwright is supplied by a bundled runtime.
const { createBrowserSession } = require("./browser-session.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const previewName = `editor-fragments-${process.pid}.html`;
const previewPath = path.join(root, "src/frontend/.cache", previewName);
fs.mkdirSync(path.dirname(previewPath), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "fixtures/editor-preview.html"),
  previewPath,
);
const previewUrl = `${process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173"}/.cache/${previewName}`;
const clip = fs.readFileSync(`${root}/storage/videos/pusht-demo.mp4`);
const base = () => ({
  id: "mock-task",
  title: "第五步 · 工作台组件预览",
  tenant_id: "mock-tenant",
  tenant_name: "预览租户 A",
  duration_ms: 2565000,
  status: "in_progress",
  assignee_id: "mock-a1",
  assignee_name: "标注员 A1",
  created_at: "2026-10-23T01:00:00Z",
  submitted_at: null,
  revision: 7,
  segments: [{ start_ms: 1000, end_ms: 2000 }],
  effective_ms: 1000,
});
let server = base(),
  writes = [],
  fail = null;
let saveGate = null;
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out");
}
(async () => {
  const session = await createBrowserSession("workspace", {
    width: 1280,
    height: 1100,
  });
  const { context, page } = session;
  const errors = [];
  let acceptDialogs = true;
  let frameMode = "ready";
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => (acceptDialogs ? d.accept() : d.dismiss()));
  await context.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/stats/me")
      return route.fulfill({
        json: {
          timezone: "Asia/Shanghai",
          start_date: "2025-10-24",
          end_date: "2026-10-23",
          task_count: server.status === "submitted" ? 1 : 0,
          effective_ms: server.status === "submitted" ? server.effective_ms : 0,
          today_count: server.status === "submitted" ? 1 : 0,
          active_days: server.status === "submitted" ? 1 : 0,
          items: [],
        },
      });
    if (url.pathname.endsWith("/frames")) {
      if (frameMode === "error")
        return route.fulfill({
          status: 503,
          json: { detail: "模拟帧读取失败" },
        });
      return route.fulfill({
        json: {
          frame_times_ms: Array.from({ length: 25650 }, (_, i) => i * 100),
        },
      });
    }
    if (url.pathname === "/api/auth/me") {
      const admin = new URL(page.url()).searchParams.get("role") === "admin";
      return route.fulfill({
        json: {
          user: {
            id: admin ? "mock-admin" : "mock-a1",
            username: admin ? "admin" : "a1",
            display_name: "局部组件预览",
            role: admin ? "admin" : "annotator",
            tenant_id: admin ? null : "mock-tenant",
            tenant_name: admin ? null : "预览租户",
          },
          csrf_token: "mock-only-token",
        },
      });
    }
    if (url.pathname === "/api/tasks" && req.method() === "GET")
      return route.fulfill({
        json: { items: [server], total: 1, page: 1, page_size: 10 },
      });
    if (url.pathname === "/api/tenants" && req.method() === "GET")
      return route.fulfill({ json: [{ id: "mock-tenant", name: "预览租户" }] });
    if (url.pathname.endsWith("/video")) {
      const range = req.headers().range;
      let start = 0,
        end = clip.length - 1;
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
      }
      return route.fulfill({
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` }
            : {}),
        },
        body: clip.subarray(start, end + 1),
      });
    }
    if (url.pathname === "/api/tasks/mock-task" && req.method() === "GET")
      return route.fulfill({ json: server });
    if (
      ["/api/tasks/mock-task/segments", "/api/tasks/mock-task/submit"].includes(
        url.pathname,
      )
    ) {
      const payload = req.postDataJSON();
      writes.push({ path: url.pathname, payload });
      if (saveGate) await saveGate;
      if (fail === "503") {
        fail = null;
        return route.fulfill({ status: 503, json: { detail: "模拟保存失败" } });
      }
      if (server.status === "submitted") {
        if (
          url.pathname.endsWith("/submit") &&
          JSON.stringify(payload.segments) === JSON.stringify(server.segments)
        )
          return route.fulfill({ json: server });
        return route.fulfill({ status: 409, json: { detail: "任务已提交" } });
      }
      if (payload.expected_revision !== server.revision)
        return route.fulfill({
          status: 409,
          json: { detail: "任务已在其他页面更新；请先重新载入，再确认片段" },
        });
      server = {
        ...server,
        revision: server.revision + 1,
        segments: payload.segments,
        effective_ms: payload.segments.reduce(
          (n, s) => n + s.end_ms - s.start_ms,
          0,
        ),
      };
      if (url.pathname.endsWith("/submit"))
        server = {
          ...server,
          status: "submitted",
          submitted_at: "2026-10-23T02:00:00Z",
        };
      if (fail === "lost-submit") {
        fail = null;
        return route.abort("failed");
      }
      return route.fulfill({ json: server });
    }
    throw new Error(`Unexpected mocked API ${req.method()} ${url.pathname}`);
  });
  const start = async (role = "") => {
    server = base();
    writes = [];
    fail = null;
    await page.goto(previewUrl + role);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page
      .getByRole("heading", { name: "第五步 · 工作台组件预览" })
      .waitFor();
  };
  const endInput = () => page.getByLabel("片段 1 终点", { exact: true });
  async function checkNavigationWhileLocked() {
    await start();
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    const player = page.locator("video");
    const timeline = page.getByRole("region", {
      name: "片段时间轴",
      exact: true,
    });
    await until(() => player.evaluate((v) => v.readyState >= 1));
    await endInput().fill("2.250");
    let release;
    saveGate = new Promise((resolve) => {
      release = resolve;
    });
    await page.getByRole("button", { name: "立即保存", exact: true }).click();
    await until(() => writes.length === 1);
    await player.click();
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
    });
    await page.keyboard.press("ArrowRight");
    const duringSaveVideo = await player.evaluate((v) =>
      Math.round(v.currentTime * 1000),
    );
    await timeline.focus();
    await page.keyboard.press("ArrowRight");
    const duringSaveTimeline = await player.evaluate((v) =>
      Math.round(v.currentTime * 1000),
    );
    release();
    saveGate = null;
    await until(
      async () =>
        await page
          .getByRole("button", { name: "立即保存", exact: true })
          .isEnabled(),
    );
    assert.equal(
      duringSaveVideo,
      12565,
      "saving must not block player arrow navigation",
    );
    assert.equal(
      duringSaveTimeline,
      12600,
      "saving must not block timeline frame navigation",
    );
    await endInput().fill("2.500");
    await until(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((key) =>
          key.startsWith("annotation-draft-v1:"),
        ),
      ),
    );
    await page.reload();
    await page
      .getByRole("button", { name: "恢复本机草稿", exact: true })
      .waitFor();
    await until(() => player.evaluate((v) => v.readyState >= 1));
    await player.click();
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12565,
      "pending recovery must not block video navigation",
    );
    await timeline.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12600,
      "pending recovery must not block timeline navigation",
    );
    await page.keyboard.press("i");
    await page.keyboard.press("Control+s");
    assert.equal(
      await page.getByRole("img", { name: "待完成选段", exact: true }).count(),
      0,
    );
    assert.equal(
      writes.length,
      1,
      "recovery must still lock editing and saving",
    );
    await page
      .getByRole("button", { name: "使用服务端内容", exact: true })
      .click();
    console.log(
      "PASS: both player percentage and timeline frame arrows work during pending save/recovery, while editing stays locked",
    );
  }
  async function checkTaskNavigation() {
    server = base();
    writes = [];
    let navigationTasks = [
      server,
      ...Array.from({ length: 10 }, (_, i) => ({
        ...base(),
        id: `navigation-${i + 1}`,
        title: `切换任务 ${i + 1} · 较长的标题用于窄屏排布`,
        segments: [{ start_ms: 3000, end_ms: 4000 }],
      })),
      { ...base(), id: "available-task", status: "available" },
      { ...base(), id: "submitted-task", status: "submitted" },
    ];
    let failNavigation = true;
    const navigationRoute = async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/tasks" && !url.searchParams.has("status")) {
        return route.fulfill({
          json: {
            items: [
              server,
              { ...base(), id: "available-task", status: "available" },
              { ...base(), id: "submitted-task", status: "submitted" },
            ],
            total: 3,
            page: 1,
            page_size: 10,
          },
        });
      }
      if (url.pathname === "/api/tasks" && url.searchParams.has("status")) {
        assert.equal(url.searchParams.get("status"), "in_progress");
        if (failNavigation)
          return route.fulfill({
            status: 503,
            json: { detail: "模拟列表失败" },
          });
        const currentPage = Number(url.searchParams.get("page"));
        const pageSize = Number(url.searchParams.get("page_size"));
        const tasks = navigationTasks.filter((t) => t.status === "in_progress");
        return route.fulfill({
          json: {
            items: tasks.slice(
              (currentPage - 1) * pageSize,
              currentPage * pageSize,
            ),
            total: tasks.length,
            page: currentPage,
            page_size: pageSize,
          },
        });
      }
      const task = navigationTasks.find(
        (t) => url.pathname === `/api/tasks/${t.id}`,
      );
      if (task && task.id !== server.id) return route.fulfill({ json: task });
      return route.fallback();
    };
    await context.route("**/api/**", navigationRoute);
    await page.goto(previewUrl + "?app=1");
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    const toggle = page.getByRole("button", {
      name: "我的任务",
      exact: true,
    });
    const dropdown = page.getByRole("region", {
      name: "标注中任务",
      exact: true,
    });
    const allTasks = page.getByRole("button", {
      name: "查看全部任务",
      exact: true,
    });
    const first = () =>
      dropdown.getByRole("button", { name: server.title, exact: false });
    const second = () =>
      dropdown.getByRole("button", {
        name: navigationTasks[1].title,
        exact: false,
      });
    const assertInsideSidebar = async () => {
      if (page.viewportSize().width > 720) {
        assert.equal(
          await page.locator(".sidebar .brand-name").isVisible(),
          true,
          "expanded sidebar keeps the original brand",
        );
        assert.equal(
          await page.locator(".sidebar .workspace-label").isVisible(),
          true,
          "expanded sidebar keeps WORKSPACE",
        );
        assert.equal(
          await page.locator(".sidebar .sidebar-bottom").isVisible(),
          true,
          "expanded sidebar keeps tenant information",
        );
      }
      assert.equal(
        await dropdown.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const sidebar = node.closest(".sidebar").getBoundingClientRect();
          const trigger = node.previousElementSibling.getBoundingClientRect();
          return (
            getComputedStyle(node).position === "static" &&
            bounds.left >= sidebar.left &&
            bounds.right <= sidebar.right &&
            bounds.top >= trigger.bottom &&
            bounds.bottom <= sidebar.bottom
          );
        }),
        true,
        "task children belong below the trigger inside the sidebar",
      );
    };
    const sidebarWidth = async () =>
      Math.round((await page.locator(".sidebar").boundingBox()).width);
    assert.equal(
      await sidebarWidth(),
      70,
      "task list starts with the same narrow rail as the editor",
    );
    await page
      .getByRole("button", { name: "展开侧栏", exact: true })
      .locator(".brand-icon")
      .click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await dropdown.getByRole("alert").waitFor();
    assert.equal(
      await allTasks.isEnabled(),
      true,
      "all tasks remains available when the in-progress query fails",
    );
    await allTasks.click();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    assert.equal(await allTasks.getAttribute("aria-current"), "page");
    failNavigation = false;
    await dropdown.getByRole("button", { name: "重试", exact: true }).click();
    await first().waitFor();
    assert.equal(await sidebarWidth(), 220);
    assert.equal(await dropdown.locator("li").count(), 10);
    const entryTop = (await allTasks.boundingBox()).y;
    await dropdown.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    assert.equal(
      (await allTasks.boundingBox()).y,
      entryTop,
      "all-tasks entry stays fixed while task rows scroll",
    );
    await assertInsideSidebar();
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 70);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.press("Enter");
    assert.equal(
      await page
        .getByRole("button", { name: "收起侧栏", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await first().waitFor();
    assert.equal(
      await first().evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(
            bounds.right - 8,
            bounds.top + bounds.height / 2,
          ),
        );
      }),
      true,
      "sidebar task rows must remain clickable",
    );
    failNavigation = true;
    await dropdown
      .getByRole("button", { name: "加载更多", exact: true })
      .click();
    await dropdown.getByRole("alert").waitFor();
    assert.equal(await dropdown.locator("li").count(), 10);
    failNavigation = false;
    await dropdown.getByRole("button", { name: "重试", exact: true }).click();
    await until(async () => (await dropdown.locator("li").count()) === 11);
    await dropdown
      .getByRole("button", { name: navigationTasks[10].title, exact: false })
      .waitFor();
    await first().click();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    assert.equal(await dropdown.count(), 1);
    assert.equal(
      await sidebarWidth(),
      220,
      "opening a task keeps navigation expanded",
    );
    await page
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor({ timeout: 2000 });
    assert.equal(
      await sidebarWidth(),
      220,
      "one click returns to the list and preserves expansion",
    );
    await toggle.click();
    assert.equal(await sidebarWidth(), 220);
    assert.equal(await dropdown.count(), 0);
    await toggle.click();
    await first().click();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    assert.equal(
      await dropdown.count(),
      1,
      "clicking outside must not move the sidebar",
    );
    await assertInsideSidebar();
    assert.equal(await first().getAttribute("aria-current"), "page");
    await first().click();
    assert.equal(await dropdown.count(), 1);
    await endInput().fill("5.250");
    await toggle.click();
    assert.equal(await dropdown.count(), 0);
    assert.equal(
      await sidebarWidth(),
      220,
      "hiding My Tasks must not collapse the sidebar",
    );
    assert.equal(await endInput().inputValue(), "5.250");
    await toggle.click();
    assert.equal(await dropdown.count(), 1);
    await page
      .getByRole("button", { name: "收起侧栏", exact: true })
      .locator(".brand-icon")
      .click();
    assert.equal(
      await dropdown.count(),
      0,
      "clicking the brand only collapses navigation and preserves unsaved edits",
    );
    assert.equal(await endInput().inputValue(), "5.250");
    await toggle.locator("svg").first().click();
    assert.equal(
      await dropdown.count(),
      1,
      "folder icon shares the disclosure button",
    );
    acceptDialogs = false;
    await allTasks.click();
    assert.equal(
      await endInput().inputValue(),
      "5.250",
      "cancelled all-tasks navigation preserves the draft",
    );
    assert.equal(await allTasks.getAttribute("aria-current"), null);
    await page
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    assert.equal(await endInput().inputValue(), "5.250");
    assert.equal(
      await dropdown.count(),
      1,
      "cancelled navigation leaves layout and edits intact",
    );
    await second().click();
    assert.equal(await endInput().inputValue(), "5.250");
    assert.equal(await dropdown.count(), 1);
    acceptDialogs = true;
    await second().click();
    await page
      .getByRole("heading", { name: navigationTasks[1].title, exact: true })
      .waitFor();
    assert.equal(
      await endInput().inputValue(),
      "4",
      "switch must mount the target editor",
    );
    await page.reload();
    await page
      .getByRole("heading", { name: navigationTasks[1].title, exact: true })
      .waitFor();
    await toggle.click();
    await first().click();
    await page
      .getByRole("button", { name: "恢复本机草稿", exact: true })
      .click();
    assert.equal(await endInput().inputValue(), "5.250");
    let release;
    saveGate = new Promise((resolve) => {
      release = resolve;
    });
    await page.getByRole("button", { name: "立即保存", exact: true }).click();
    await until(() => writes.length === 1);
    assert.equal(
      await second().isDisabled(),
      true,
      "saving blocks task changes",
    );
    assert.equal(
      await allTasks.isDisabled(),
      true,
      "saving also blocks the permanent list entry",
    );
    release();
    saveGate = null;
    await until(() => second().isEnabled());
    await page.keyboard.press("Escape");
    assert.equal(
      await toggle.getAttribute("aria-expanded"),
      "true",
      "Escape does not collapse My Tasks",
    );
    await toggle.click();
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.click();
    const bounds = await dropdown.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await assertInsideSidebar();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator(".sidebar .brand").click();
    assert.equal(await dropdown.count(), 0);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(await dropdown.count(), 1);
    await toggle.click();
    assert.equal(await dropdown.count(), 0);
    navigationTasks = [];
    await toggle.click();
    await dropdown.getByText("暂无标注中的任务", { exact: true }).waitFor();
    await page.setViewportSize(viewport);
    await toggle.locator(".task-navigation-chevron").click();
    assert.equal(
      await dropdown.count(),
      0,
      "arrow only collapses without leaving the editor",
    );
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    assert.equal(await sidebarWidth(), 220);
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 70);
    await page
      .getByRole("button", { name: "展开侧栏", exact: true })
      .press("Enter");
    assert.equal(await sidebarWidth(), 220);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      await dropdown.count(),
      0,
      "brand preserves the previously closed task menu",
    );
    await toggle.press("Enter");
    assert.equal(await dropdown.count(), 1);
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    assert.equal(
      await dropdown.count(),
      1,
      "explicit back button preserves expanded state across pages",
    );
    assert.equal(await sidebarWidth(), 220);
    await toggle.click();
    assert.equal(await sidebarWidth(), 220);
    assert.equal(await dropdown.count(), 0);
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    assert.equal(await sidebarWidth(), 70);
    await toggle.click();
    assert.equal(await sidebarWidth(), 220);
    assert.equal(
      await dropdown.count(),
      0,
      "My Tasks on a collapsed rail expands it without changing the menu state",
    );
    await toggle.click();
    assert.equal(await dropdown.count(), 1);
    const statusWidths = await page
      .locator("table .status-badge")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width),
      );
    assert.equal(statusWidths.length, 3);
    assert.equal(
      new Set(statusWidths).size,
      1,
      "all task statuses have equal badge widths",
    );
    await page.locator("table .task-title").first().click();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    await dropdown.getByText("暂无标注中的任务", { exact: true }).waitFor();
    await allTasks.click();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    assert.equal(await allTasks.getAttribute("aria-current"), "page");
    await page.getByRole("button", { name: "进行中", exact: true }).click();
    await allTasks.click();
    assert.equal(
      await page.locator('.tabs button[aria-pressed="true"]').innerText(),
      "全部任务",
      "explicit all-tasks navigation resets list filters",
    );
    await context.unroute("**/api/**", navigationRoute);
    console.log(
      "PASS: in-progress task dropdown filters and paginates, retries failures, switches editors with draft guard/recovery, remembers target, blocks busy changes and fits mobile",
    );
  }
  async function checkRefreshState() {
    server = base();
    writes = [];
    fail = null;
    await page.goto(previewUrl + "?app=1");
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "继续标注", exact: false }).click();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    const location = page.getByRole("status", {
      name: "草稿保存位置",
      exact: true,
    });
    const autoSave = page.getByLabel("自动保存（停止编辑 1.5 秒后）");
    assert.equal(await location.innerText(), "已保存到服务器");
    await autoSave.uncheck();
    await endInput().fill("5.125");
    await until(async () => (await location.innerText()) === "仅有本机备份");
    await page.clock.runFor(1700);
    assert.equal(writes.length, 0);
    await page.reload();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "我的任务", exact: true })
        .count(),
      0,
    );
    assert.equal(await autoSave.isChecked(), false);
    await page
      .getByRole("button", { name: "恢复本机草稿", exact: true })
      .click();
    assert.equal(await endInput().inputValue(), "5.125");
    assert.equal(await autoSave.isChecked(), false);
    await until(async () => (await location.innerText()) === "仅有本机备份");
    await page.clock.runFor(1700);
    assert.equal(writes.length, 0);
    await page.getByRole("button", { name: "立即保存", exact: true }).click();
    await until(async () => (await location.innerText()) === "已保存到服务器");
    assert.equal(server.segments[0].end_ms, 5125);
    assert.equal(writes.length, 1);
    await page.reload();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    assert.equal(await endInput().inputValue(), "5.125");
    assert.equal(await autoSave.isChecked(), false);
    assert.equal(await location.innerText(), "已保存到服务器");
    assert.equal(
      await page
        .getByRole("button", { name: "恢复本机草稿", exact: true })
        .count(),
      0,
    );
    await autoSave.check();
    await page.reload();
    await page
      .getByRole("heading", { name: server.title, exact: true })
      .waitFor();
    assert.equal(await autoSave.isChecked(), true);
    await page
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    // A wide task table must scroll locally, including its visually hidden heading.
    const listViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize(listViewport);
    await page.goto(previewUrl + "?app=1&role=admin");
    await page
      .getByRole("heading", { name: "所有任务", exact: true })
      .waitFor();
    console.log(
      "PASS: task page and autosave preference survive refresh; unsynced edits recover without upload; immediate save changes local-only status to server-saved; return navigation and account pages stay separate",
    );
    await checkTaskNavigation();
  }
  async function checkPendingSelection() {
    await checkRemarkSelection();
    await start();
    await page.waitForFunction(
      () => document.querySelector("video").readyState >= 1,
    );
    const player = page.locator("video");
    const pending = page.getByRole("img", { name: "待完成选段", exact: true });
    const move = async (seconds) => {
      await player.evaluate((v, seconds) => {
        v.pause();
        v.currentTime = seconds;
        v.dispatchEvent(new Event("timeupdate"));
      }, seconds);
    };
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    await page
      .getByRole("button", { name: "聚焦所选片段", exact: true })
      .click();
    assert(
      Number(
        await page
          .getByLabel("视频播放位置", { exact: true })
          .getAttribute("max"),
      ) < server.duration_ms,
    );
    await move(100);
    await player.focus();
    await page.keyboard.press("i");
    await pending.waitFor();
    assert.equal(await pending.getAttribute("data-start-ms"), "100000");
    assert.equal(await pending.getAttribute("data-end-ms"), "100000");
    assert((await pending.boundingBox()).width >= 6);
    assert.equal(
      Number(
        await page
          .getByLabel("视频播放位置", { exact: true })
          .getAttribute("max"),
      ),
      server.duration_ms,
    );
    assert.equal(await page.locator(".segment-row").count(), 1);
    await page.clock.runFor(1700);
    assert.equal(
      writes.length,
      0,
      "pending selection must not trigger autosave",
    );
    await move(300);
    assert.equal(await pending.getAttribute("data-end-ms"), "300000");
    assert((await pending.boundingBox()).width > 6);
    await move(90);
    assert((await pending.getAttribute("class")).includes("reversed"));
    await page.keyboard.press("o");
    assert.equal(await pending.count(), 1);
    assert.equal(await page.locator(".segment-row").count(), 1);
    await page.keyboard.press("Alt+x");
    assert.equal(await pending.count(), 0);
    await move(400);
    await page.getByRole("button", { name: "标记起点", exact: false }).click();
    await pending.waitFor();
    await page.getByRole("button", { name: "取消选段", exact: true }).click();
    assert.equal(await pending.count(), 0);

    await move(100);
    await player.focus();
    await page.keyboard.press("i");
    await move(300);
    await endInput().fill("3");
    await page.getByRole("button", { name: "立即保存", exact: true }).click();
    await until(() => server.revision === 8);
    await until(() =>
      page
        .getByRole("button", { name: "标记终点并添加", exact: false })
        .isEnabled(),
    );
    assert.deepEqual(writes[0].payload.segments, [
      { start_ms: 1000, end_ms: 3000 },
    ]);
    assert.equal(await pending.count(), 1);
    await page
      .getByRole("region", { name: "片段时间轴", exact: true })
      .screenshot({ path: `${root}/.cache/pending-selection.png` });

    await page.reload();
    await page
      .getByRole("button", { name: "恢复本机草稿", exact: true })
      .click();
    await pending.waitFor();
    assert.equal(await pending.getAttribute("data-start-ms"), "100000");
    await page.waitForFunction(
      () => document.querySelector("video").readyState >= 1,
    );
    await move(300);
    await player.focus();
    await page.keyboard.press("o");
    assert.equal(await pending.count(), 0);
    assert.equal(
      await page.getByLabel("片段 2 起点", { exact: true }).inputValue(),
      "100",
    );
    assert.equal(
      await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
      "300",
    );
    assert.equal(writes.length, 1);
    console.log(
      "PASS: I immediately previews a zero-width start, follows playback/seeks, survives recovery, cancels, and only O adds a segment; saves exclude the pending region",
    );
  }
  async function checkRemarkSelection() {
    await start();
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    server.segments = [
      { start_ms: 10000, end_ms: 20000 },
      { start_ms: 30000, end_ms: 40000 },
      { start_ms: 50000, end_ms: 60000 },
    ];
    await page.reload();
    const player = page.locator("video");
    const move = async (seconds) => {
      await until(() => player.evaluate((v) => v.readyState >= 1));
      await player.evaluate((v, at) => {
        v.pause();
        v.currentTime = at;
        v.dispatchEvent(new Event("timeupdate"));
        v.focus();
      }, seconds);
    };
    const pending = page.getByRole("img", { name: "待完成选段", exact: true });
    const status = page.getByRole("status", { name: "选段状态", exact: true });
    await move(12);
    await page.keyboard.press("i");
    await page
      .getByRole("button", { name: "标记终点并替换", exact: false })
      .waitFor();
    assert.equal(
      await page.getByLabel("片段 1 起点", { exact: true }).inputValue(),
      "10",
    );
    await move(18);
    await page.keyboard.press("o");
    assert.equal(await page.locator(".segment-row").count(), 3);
    assert.equal(
      await page.getByLabel("片段 1 起点", { exact: true }).inputValue(),
      "12",
    );
    assert.equal(await endInput().inputValue(), "18");
    await page.keyboard.press("Control+z");
    assert.equal(await endInput().inputValue(), "20");
    await page.keyboard.press("Control+Shift+z");
    assert.equal(await endInput().inputValue(), "18");
    await page.keyboard.press("Control+z");

    await move(12);
    await page.keyboard.press("i");
    // Selecting or traversing another row must not retarget this gesture.
    await page.getByRole("button", { name: "定位片段 2", exact: true }).click();
    assert.match(await status.innerText(), /重新标记片段 01/);
    await move(55);
    await page.keyboard.press("o");
    assert.match(await status.innerText(), /02、03.*重叠/);
    assert.equal(
      await page.locator(".timeline-segment.selection-conflict").count(),
      2,
    );
    assert.equal(await page.locator(".timeline-overlap").count(), 2);
    assert.equal(await endInput().inputValue(), "20");
    assert.equal(
      await page.getByLabel("片段 2 起点", { exact: true }).inputValue(),
      "30",
    );
    assert.equal(await pending.count(), 1);
    assert.equal(writes.length, 0);
    await page.getByRole("button", { name: "立即保存", exact: true }).click();
    await until(() => writes.length === 1 && server.revision === 8);
    assert.deepEqual(writes[0].payload.segments, [
      { start_ms: 10000, end_ms: 20000 },
      { start_ms: 30000, end_ms: 40000 },
      { start_ms: 50000, end_ms: 60000 },
    ]);
    await page.reload();
    await page
      .getByRole("button", { name: "恢复本机草稿", exact: true })
      .click();
    assert.match(await status.innerText(), /重新标记片段 01/);
    await move(30);
    await page.keyboard.press("o");
    assert.equal(await page.locator(".segment-row").count(), 3);
    assert.equal(
      await page.getByLabel("片段 1 起点", { exact: true }).inputValue(),
      "12",
    );
    assert.equal(await endInput().inputValue(), "30");
    assert.equal(
      await page.getByLabel("片段 2 起点", { exact: true }).inputValue(),
      "30",
    );
    await player.focus();
    await page.keyboard.press("Control+z");
    assert.equal(await endInput().inputValue(), "20");
    // Exactly on the shared boundary belongs to the following interval.
    await move(30);
    await page.keyboard.press("i");
    assert.match(await status.innerText(), /重新标记片段 02/);
    await move(35);
    await page.getByRole("button", { name: "取消选段", exact: true }).click();
    assert.equal(await pending.count(), 0);
    assert.equal(
      await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
      "40",
    );
    // Reversed/zero ranges cannot change the original; correcting O can retry.
    await move(12);
    await page.keyboard.press("i");
    await move(11);
    await page.keyboard.press("o");
    assert.equal(await pending.count(), 1);
    assert.equal(await endInput().inputValue(), "20");
    await move(12);
    await page.keyboard.press("o");
    assert.equal(await pending.count(), 1);
    await page.keyboard.press("Alt+x");
    // Starting at a clip's exclusive end creates a new clip in the gap.
    await move(12);
    await page.keyboard.press("i");
    await move(8);
    await page.keyboard.press("i");
    assert.match(await status.innerText(), /重新标记片段 01/);
    await move(25);
    await page.keyboard.press("o");
    assert.equal(
      await page.getByLabel("片段 1 起点", { exact: true }).inputValue(),
      "8",
    );
    assert.equal(await endInput().inputValue(), "25");
    await page.keyboard.press("Control+z");
    await move(45);
    await page.keyboard.press("i");
    await move(55);
    await page.keyboard.press("o");
    assert.match(await status.innerText(), /03.*重叠/);
    assert.equal(await page.locator(".segment-row").count(), 3);
    await page.keyboard.press("Alt+x");
    await move(20);
    await page.keyboard.press("i");
    assert.match(await status.innerText(), /新建片段/);
    await move(30);
    await page.keyboard.press("o");
    assert.equal(await page.locator(".segment-row").count(), 4);
    assert.equal(
      await page.getByLabel("片段 4 起点", { exact: true }).inputValue(),
      "20",
    );
    assert.equal(
      await page.getByLabel("片段 4 终点", { exact: true }).inputValue(),
      "30",
    );
    console.log(
      "PASS: I locks half-open target, O replaces once, undo/redo restores, crossing multiple clips preserves originals, recovery keeps target, touching edges/new gaps and cancel/retry work",
    );
  }
  async function checkFrameShortcuts() {
    await checkNavigationWhileLocked();
    await start();
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    const player = page.locator("video");
    await until(() => player.evaluate((v) => v.readyState >= 1));
    const timelineArea = page.getByRole("region", {
      name: "片段时间轴",
      exact: true,
    });
    // Real clicks must switch focus back from timeline to video (not just a
    // synthetic focus() call), and player toolbar buttons use video steps too.
    await timelineArea.focus();
    await player.click();
    assert.equal(
      await player.evaluate((v) => document.activeElement === v),
      true,
    );
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12565,
    );
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      38215,
    );
    // Clicking actual page content must clear the previous timeline context.
    await timelineArea.focus();
    await page.getByRole("heading", { name: "片段标注", exact: true }).click();
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12565,
    );
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      38215,
    );
    await player.focus();
    assert.equal(
      await player.evaluate((v) => getComputedStyle(v).outlineStyle),
      "none",
    );
    await player.evaluate((v) => {
      v.currentTime = 10;
    });
    await page.getByRole("button", { name: "前进 1 秒", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12565,
    );
    // Space belongs exclusively to playback, including on buttons, sliders,
    // checkboxes and time inputs. It must never submit/delete/add/toggle them.
    const stableControls = () =>
      page.evaluate(() => ({
        rows: document.querySelectorAll(".segment-row").length,
        selected: document.querySelectorAll(".segment-row.selected").length,
        checked: document.querySelector(".autosave-toggle input").checked,
        muted: document.querySelector("video").muted,
        fullscreen: !!document.fullscreenElement,
        end: document.querySelector('[aria-label="片段 1 终点"]').value,
        rate: document.querySelector('[aria-label="播放速度"]').value,
      }));
    for (const control of [
      timelineArea,
      page.getByLabel("视频播放位置", { exact: true }),
      page.getByRole("button", { name: "显示全片", exact: true }),
      page.getByRole("button", { name: "添加片段", exact: true }),
      page.getByRole("button", { name: "删除片段 1", exact: true }),
      page.getByRole("button", { name: "提交任务", exact: true }),
      page.getByRole("button", { name: "静音", exact: true }),
      page.getByRole("button", { name: "全屏播放", exact: true }),
      page.locator(".play-toggle"),
      page.getByRole("button", { name: "快捷键", exact: true }),
      page.getByLabel("自动保存（停止编辑 1.5 秒后）"),
      page.getByLabel("片段 1 终点", { exact: true }),
      page.getByLabel("时间轴片段 1 终点", { exact: true }),
      page.getByLabel("所选片段终点秒数", { exact: true }),
      page.getByLabel("播放速度", { exact: true }),
    ]) {
      await control.focus();
      const unchanged = await stableControls();
      await page.keyboard.press("Space");
      await until(() => player.evaluate((v) => !v.paused));
      await page.keyboard.press("Space");
      await until(() => player.evaluate((v) => v.paused));
      assert.deepEqual(await stableControls(), unchanged);
      assert.equal(writes.length, 0);
    }
    await timelineArea.click({ position: { x: 8, y: 8 } });
    await page.keyboard.down("Space");
    await until(() => player.evaluate((v) => !v.paused));
    await page.keyboard.down("Space");
    await page.keyboard.up("Space");
    assert.equal(await player.evaluate((v) => v.paused), false);
    await page.keyboard.press("Space");
    await until(() => player.evaluate((v) => v.paused));
    console.log(
      "PASS: real video clicks restore percentage steps; toolbar routing; Space only plays/pauses across timeline, inputs, buttons and checkbox, with held-repeat suppression",
    );
    // The custom player preserves native volume, mute and fullscreen capabilities.
    await page.getByRole("button", { name: "静音", exact: true }).click();
    assert.equal(await player.evaluate((v) => v.muted), true);
    await page.getByRole("button", { name: "取消静音", exact: true }).click();
    assert.equal(await player.evaluate((v) => v.muted), false);
    const volumeControl = page.getByLabel("音量", { exact: true });
    await volumeControl.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await player.evaluate((v) => v.volume), 0.4);
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    await page.getByRole("button", { name: "全屏播放", exact: true }).click();
    await until(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains("player-workspace"),
      ),
    );
    assert.equal(
      await page.getByRole("button", { name: "播放", exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.getByLabel("视频内播放进度", { exact: true }).isVisible(),
      true,
    );
    assert.equal(await timelineArea.isVisible(), true);
    assert.ok(
      await timelineArea.evaluate(
        (el) => el.getBoundingClientRect().height <= 150,
      ),
      "fullscreen timeline should fit a compact editing strip",
    );
    assert.equal(
      await page.getByLabel("所选片段终点秒数", { exact: true }).isVisible(),
      true,
    );
    await page.getByLabel("时间轴片段 1 终点", { exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await endInput().inputValue(), "2.1");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await endInput().inputValue(), "2");
    assert.equal(
      await timelineArea.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
      true,
    );
    await page.getByRole("button", { name: "显示全片", exact: true }).focus();
    await page.keyboard.press("Space");
    await until(() => player.evaluate((v) => !v.paused));
    await page.keyboard.press("Space");
    await until(() => player.evaluate((v) => v.paused));
    await player.click();
    await player.evaluate((v) => {
      v.currentTime = 10;
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12565,
    );
    await page.getByLabel("视频播放位置", { exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await player.evaluate((v) => Math.round(v.currentTime * 1000)),
      12600,
    );
    const shortcutButton = page.getByRole("button", {
      name: "快捷键",
      exact: true,
    });
    await shortcutButton.click();
    assert.equal(
      await page
        .getByRole("region", { name: "常用快捷键", exact: true })
        .isVisible(),
      true,
    );
    const help = page.locator("#workspace-shortcuts");
    assert.equal(await help.locator(".shortcut-common > div").count(), 6);
    assert.match(
      await help.locator(".shortcut-context-active").innerText(),
      /时间轴/,
    );
    assert.equal(
      await help.getByText("选段规则", { exact: true }).isVisible(),
      true,
    );
    await help.getByText("选段规则", { exact: true }).click();
    await help
      .getByText("Alt / Option + X 只取消未完成选段，保留已确认片段。", {
        exact: true,
      })
      .waitFor();
    await help.getByText("选段规则", { exact: true }).click();
    await shortcutButton.click();
    const pending = page.getByRole("img", { name: "待完成选段", exact: true });
    await player.focus();
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
    });
    await page.keyboard.press("i");
    await pending.waitFor();
    await page.keyboard.press("Escape");
    await until(() => page.evaluate(() => document.fullscreenElement === null));
    assert.equal(
      await pending.count(),
      1,
      "Escape exits native fullscreen while preserving unfinished selection",
    );
    await page.getByRole("button", { name: "全屏播放", exact: true }).click();
    await until(() => page.evaluate(() => !!document.fullscreenElement));
    await player.focus();
    await page.keyboard.press("Alt+x");
    assert.equal(await pending.count(), 0);
    assert.equal(
      await page.evaluate(() => !!document.fullscreenElement),
      true,
      "Alt+X cancels without exiting fullscreen",
    );
    assert.equal(await page.locator(".segment-row").count(), 1);
    assert.equal(await endInput().inputValue(), "2");
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await until(() => page.evaluate(() => document.fullscreenElement === null));
    assert.equal(
      await page
        .getByRole("button", { name: "全屏播放", exact: true })
        .isVisible(),
      true,
    );
    // Blank-space dismissal clears all linked highlights without editing data.
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    await page
      .getByRole("button", { name: "聚焦所选片段", exact: true })
      .click();
    const blankTrack = await page.locator(".timeline-track").boundingBox();
    await page.mouse.click(
      blankTrack.x + blankTrack.width * 0.95,
      blankTrack.y + 45,
    );
    assert.equal(
      await page
        .locator(
          ".timeline-segment.selected, .segment-row.selected, .video-progress-segment.selected",
        )
        .count(),
      0,
    );
    assert.equal(
      await page.locator(".timeline-handle, .timeline-boundaries").count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "聚焦所选片段", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await endInput().inputValue(), "2");
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    await page.getByRole("button", { name: "前进 1 秒", exact: true }).click();
    assert.equal(await page.locator(".segment-row.selected").count(), 1);
    const pendingSeconds = page.getByLabel("所选片段终点秒数", { exact: true });
    await pendingSeconds.fill("2.500");
    await page.getByRole("heading", { name: "片段标注", exact: true }).click();
    assert.equal(await endInput().inputValue(), "2.5");
    assert.equal(await page.locator(".segment-row.selected").count(), 0);
    await endInput().fill("2");
    assert.equal(await page.locator(".segment-row.selected").count(), 1);
    await player.focus();
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator(".timeline-segment.selected, .segment-row.selected")
        .count(),
      2,
    );
    assert.equal(writes.length, 0);
    console.log(
      "PASS: blank track and panel dismiss linked selection, tool/input interactions preserve it, blur commits before dismissal, Escape never clears selection",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "定位片段 1", exact: true }).click();
    assert.equal(await page.locator(".segment-row.selected").count(), 1);
    await page.getByRole("heading", { name: "片段标注", exact: true }).click();
    assert.equal(await page.locator(".segment-row.selected").count(), 0);
    await shortcutButton.click();
    await help.getByText("更多快捷键与输入说明", { exact: true }).click();
    assert.equal(
      await help.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
      "grouped help fits the mobile player",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await help.getByText("更多快捷键与输入说明", { exact: true }).click();
    await shortcutButton.click();
    await page.setViewportSize({ width: 1280, height: 1100 });
    const current = () =>
      player.evaluate((v) => Math.round(v.currentTime * 1000));
    // Video overview and detailed ruler share one playback position, even when
    // the detailed view is focused on a short clip.
    const overview = page.getByLabel("视频内播放进度", { exact: true });
    const overviewBox = await overview.boundingBox();
    await page.mouse.click(
      overviewBox.x + overviewBox.width / 4,
      overviewBox.y + overviewBox.height / 2,
    );
    assert.ok(
      Math.abs((await current()) - server.duration_ms / 4) <
        server.duration_ms * 0.01,
    );
    assert.equal(
      Number(
        await page.getByLabel("视频播放位置", { exact: true }).inputValue(),
      ),
      await current(),
    );
    await overview.focus();
    const beforeStep = await current();
    await page.keyboard.press("ArrowRight");
    assert.equal(await current(), beforeStep + 2565);
    await page.keyboard.press("Shift+ArrowLeft");
    assert.equal(await current(), beforeStep + 2565 - 25650);
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    await page
      .getByRole("button", { name: "聚焦所选片段", exact: true })
      .click();
    const trackBox = await page.locator(".timeline-track").boundingBox();
    const handle = page.getByLabel("时间轴片段 1 终点", { exact: true });
    // The actual thumb lives on the selected block, not in a separate slider row.
    await page.mouse.move(
      trackBox.x + (trackBox.width * 2) / 3,
      trackBox.y + 27,
    );
    await page.mouse.down();
    await page.mouse.move(
      trackBox.x + (trackBox.width * 5) / 6,
      trackBox.y + 27,
      { steps: 8 },
    );
    await page.mouse.up();
    assert.ok(Math.abs(Number(await endInput().inputValue()) - 2.5) < 0.03);
    await handle.focus();
    await page.keyboard.press("Control+z");
    assert.equal(await endInput().inputValue(), "2");
    const seconds = page.getByLabel("所选片段终点秒数", { exact: true });
    await seconds.fill("2.750");
    await seconds.press("Enter");
    assert.equal(await endInput().inputValue(), "2.75");
    await seconds.fill("0.500");
    await seconds.press("Enter");
    assert.equal(await endInput().inputValue(), "1.001");
    assert.equal(await seconds.inputValue(), "1.001");
    await seconds.fill("");
    await seconds.press("Tab");
    assert.equal(await seconds.inputValue(), "1.001");
    await seconds.fill("2.000");
    await seconds.press("Enter");
    const dragBox = await overview.boundingBox();
    await page.mouse.move(
      dragBox.x + dragBox.width / 4,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    assert.ok(
      Math.abs((await current()) - server.duration_ms / 2) <
        server.duration_ms * 0.01,
    );
    assert.equal(
      Number(await overview.getAttribute("max")),
      server.duration_ms,
    );
    assert.equal(
      Number(
        await page
          .getByLabel("视频播放位置", { exact: true })
          .getAttribute("max"),
      ),
      3000,
    );
    await page.getByRole("button", { name: "显示全片", exact: true }).click();
    assert.equal(
      Number(
        await page.getByLabel("视频播放位置", { exact: true }).inputValue(),
      ),
      await current(),
    );
    assert.equal(writes.length, 0);
    console.log(
      "PASS: video overview click/keyboard sync, fullscreen overview, focused block boundary drag/undo, precise seconds commit/clamp and empty-input recovery",
    );
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
      v.focus();
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(await current(), 12565);
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await current(), 38215);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await current(), 10000);
    const timeline = page.getByRole("region", {
      name: "片段时间轴",
      exact: true,
    });
    const playhead = page.getByLabel("视频播放位置", { exact: true });
    await playhead.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await current(), 10100);
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await current(), 10600);
    await timeline.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    assert.equal(await current(), 10100);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await current(), 10000);
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.up("ArrowRight");
    assert.equal(await current(), 10200);
    // Selecting a complete row exposes frame-based boundary controls.
    await page.getByRole("button", { name: "片段 1", exact: true }).click();
    const boundary = page.getByLabel("时间轴片段 1 终点", { exact: true });
    await boundary.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await endInput().inputValue(), "2.1");
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await endInput().inputValue(), "2.6");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await endInput().inputValue(), "2");
    await player.focus();
    await page.keyboard.press("Shift+i");
    assert.equal(await current(), 1000);
    await page.keyboard.press("Shift+o");
    assert.equal(await current(), 2000);
    assert.equal(await page.locator(".segment-row").count(), 1);
    assert.equal(
      await page.getByRole("img", { name: "待完成选段", exact: true }).count(),
      0,
    );
    await player.evaluate((v) => {
      v.currentTime = 3;
      v.focus();
    });
    await page.keyboard.press("i");
    await player.evaluate((v) => {
      v.currentTime = 4;
    });
    await page.keyboard.press("Shift+i");
    assert.equal(await current(), 3000);
    assert.equal(
      await page
        .getByRole("img", { name: "待完成选段", exact: true })
        .getAttribute("data-start-ms"),
      "3000",
    );
    await player.evaluate((v) => {
      v.currentTime = 4;
    });
    await page.keyboard.press("o");
    assert.equal(await page.locator(".segment-row").count(), 2);
    // Synthetic events avoid opening browser-native Save As / OS shortcuts.
    for (const options of [
      { key: "s", ctrlKey: true, shiftKey: true },
      { key: "s", ctrlKey: true, altKey: true },
      { key: "s", metaKey: true, shiftKey: true },
      { key: "z", ctrlKey: true, altKey: true },
      { key: "y", ctrlKey: true, shiftKey: true },
      { key: "i", ctrlKey: true, shiftKey: true },
      { key: "o", altKey: true },
    ])
      await player.evaluate(
        (el, options) =>
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              ...options,
            }),
          ),
        options,
      );
    assert.equal(writes.length, 0);
    assert.equal(await page.locator(".segment-row").count(), 2);
    await player.focus();
    await page.keyboard.press("Control+z");
    assert.equal(await page.locator(".segment-row").count(), 1);
    await page.keyboard.press("Control+Shift+z");
    assert.equal(await page.locator(".segment-row").count(), 2);
    await page.getByLabel("片段 2 终点", { exact: true }).focus();
    await page.keyboard.press("Control+s");
    await until(() => writes.length === 1);
    await player.focus();
    await page.keyboard.press("i");
    await page.keyboard.press("Escape");
    const unfinished = page.getByRole("img", {
      name: "待完成选段",
      exact: true,
    });
    assert.equal(
      await unfinished.count(),
      1,
      "Escape outside fullscreen leaves unfinished selection intact",
    );
    for (const keys of ["Control+Alt+x", "Alt+Shift+x"]) {
      await page.keyboard.press(keys);
      assert.equal(await unfinished.count(), 1);
    }
    await endInput().focus();
    await page.keyboard.press("Alt+x");
    assert.equal(
      await unfinished.count(),
      1,
      "text inputs retain Option/Alt character entry",
    );
    await player.focus();
    await player.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "x",
          code: "KeyX",
          altKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      await unfinished.count(),
      1,
      "held-repeat must not run cancellation",
    );
    await player.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "≈",
          code: "KeyX",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      await page.getByRole("img", { name: "待完成选段", exact: true }).count(),
      0,
    );
    await timeline.focus();
    await page.keyboard.press("Space");
    await until(() => player.evaluate((v) => !v.paused));
    await page.keyboard.press("ArrowLeft");
    assert.equal(await player.evaluate((v) => v.paused), true);
    frameMode = "error";
    await start();
    await page
      .getByRole("button", { name: "重试读取视频帧", exact: true })
      .waitFor();
    await player.evaluate((v) => {
      v.pause();
      v.currentTime = 10;
      v.dispatchEvent(new Event("timeupdate"));
    });
    await playhead.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await current(), 10000);
    frameMode = "ready";
    await page
      .getByRole("button", { name: "重试读取视频帧", exact: true })
      .click();
    await until(
      async () =>
        (await page
          .getByRole("button", { name: "重试读取视频帧", exact: true })
          .count()) === 0,
    );
    await playhead.focus();
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await current(), 10500);
    console.log(
      "PASS: audio mute/volume keyboard and panel fullscreen; timeline 1/5 frames and paused stepping, video 0.1%/1%, Shift I/O navigation, exact modifiers, undo/redo/save, and failed frame loading never falls back to ms",
    );
  }
  async function checkRowFeedback() {
    await start();
    server.segments = [
      { start_ms: 0, end_ms: 100000 },
      { start_ms: 200000, end_ms: 300000 },
      { start_ms: 400000, end_ms: 500000 },
      { start_ms: 800000, end_ms: 900000 },
      { start_ms: 1200000, end_ms: 1300000 },
    ];
    await page.reload();
    const add = page.getByRole("button", { name: "添加片段", exact: true });
    await add.click();
    const start6 = page.getByLabel("片段 6 起点", { exact: true });
    const end6 = page.getByLabel("片段 6 终点", { exact: true });
    await start6.fill("1");
    await end6.fill("244");
    await add.click();
    const row6 = page.locator(".segment-row").nth(5);
    const row7 = page.locator(".segment-row").nth(6);
    assert.match(await row6.locator(".segment-error").innerText(), /重叠/);
    assert.equal(await row7.locator(".segment-error").count(), 0);
    const start7 = page.getByLabel("片段 7 起点", { exact: true });
    await start6.click();
    assert.equal(
      await row6.evaluate((el) => el.classList.contains("selected")),
      true,
    );
    await row6.screenshot({ path: `${root}/.cache/row-feedback.png` });
    assert.equal(
      await row6.locator(".segment-error").evaluate((el) => {
        const error = el.getBoundingClientRect();
        const area = el.closest(".segment-list").getBoundingClientRect();
        return error.top >= area.top && error.bottom <= area.bottom;
      }),
      true,
    );
    await start7.click();
    assert.equal(
      await row7.evaluate((el) => el.classList.contains("selected")),
      true,
    );
    assert.equal(
      await row6.evaluate((el) => el.classList.contains("selected")),
      false,
    );
    await end6.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await row7.evaluate((el) => el.classList.contains("selected")),
      true,
    );
    for (const [start, end, expected] of [
      ["-1", "244", /非负秒数/],
      ["500", "400", /起点 < 终点/],
      ["2500", "3000", /终点不能超过视频时长/],
      ["3000", "", /起点不能超过视频时长/],
      ["1.0001", "244", /三位小数/],
    ]) {
      await start6.fill(start);
      await end6.fill(end);
      assert.match(await row6.locator(".segment-error").innerText(), expected);
      assert.equal(await start6.getAttribute("aria-invalid"), "true");
      assert.equal(
        await page
          .getByRole("button", { name: "立即保存", exact: true })
          .isDisabled(),
        true,
      );
    }
    await start6.fill("1300");
    await end6.fill("1400");
    assert.equal(await row6.locator(".segment-error").count(), 0);
    assert.equal(await start6.getAttribute("aria-invalid"), "false");
    await page.clock.runFor(1700);
    assert.equal(writes.length, 0, "blank row 7 must still block autosave");
    await page.getByRole("button", { name: "删除片段 7", exact: true }).click();
    await until(() => writes.length === 1);
    assert.equal(server.segments.length, 6);
    console.log(
      "PASS: row 6 shows overlap/range/format errors beside inputs with blank row 7 present; click/Tab follows selection; only valid completed rows save",
    );
  }
  async function checkAddFocus() {
    for (const viewport of [
      { width: 1280, height: 1100 },
      { width: 390, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await start();
      const list = page.locator(".segment-list");
      const add = page.getByRole("button", { name: "添加片段", exact: true });
      for (let i = 2; i <= 8; i++) {
        await add.click();
        const input = page.getByLabel(`片段 ${i} 起点`, { exact: true });
        assert.equal(
          await input.evaluate((el) => el === document.activeElement),
          true,
        );
        assert.equal(
          await input.evaluate((el) => {
            const row = el.closest(".segment-row").getBoundingClientRect();
            const area = el.closest(".segment-list").getBoundingClientRect();
            return row.top >= area.top - 1 && row.bottom <= area.bottom + 1;
          }),
          true,
        );
      }
      const outerScroll = await page.evaluate(() => window.scrollY);
      const before = await list.evaluate((el) => el.scrollTop);
      assert(before > 0);
      // Keep the pointer where the last Add click left it.
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.scrollY), outerScroll);
      await page.mouse.wheel(0, -180);
      await until(
        async () => (await list.evaluate((el) => el.scrollTop)) < before,
      );
      assert.equal(await page.evaluate(() => window.scrollY), outerScroll);
      const end = page.getByLabel("片段 8 终点", { exact: true });
      await end.fill("9");
      assert.equal(
        await end.evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(writes.length, 0);
    }
    await page.setViewportSize({ width: 1280, height: 1100 });
    console.log(
      "PASS: added rows are visible and focused; wheel at the Add pointer scrolls only the list, including at its boundary, on desktop and mobile",
    );
  }
  async function checkInputFeedback() {
    await start();
    assert.equal(await page.locator(".save-state").count(), 0);
    assert.equal(
      await page.getByText("草稿不计入每日统计", { exact: false }).count(),
      0,
    );
    await page.getByRole("button", { name: "添加片段", exact: true }).click();
    const start2 = page.getByLabel("片段 2 起点", { exact: true });
    const end2 = page.getByLabel("片段 2 终点", { exact: true });
    const save = page.getByRole("button", { name: "立即保存", exact: true });
    assert.equal(await page.locator(".validation-text").count(), 0);
    assert.equal(await save.isDisabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "提交任务", exact: true })
        .isDisabled(),
      true,
    );
    await start2.fill("3");
    assert.equal(await page.locator(".validation-text").count(), 0);
    await page.clock.runFor(1700);
    assert.equal(writes.length, 0);
    await start2.fill("-1");
    assert.match(
      await page.locator(".validation-text").innerText(),
      /非负秒数/,
    );
    await start2.fill("3");
    await end2.fill("3.0001");
    assert.match(
      await page.locator(".validation-text").innerText(),
      /三位小数/,
    );
    await end2.fill("4");
    assert.equal(await page.locator(".validation-text").count(), 0);
    await until(() => writes.length === 1);
    assert.deepEqual(server.segments, [
      { start_ms: 1000, end_ms: 2000 },
      { start_ms: 3000, end_ms: 4000 },
    ]);
    assert.equal(await page.locator(".save-state").count(), 0);
    assert.equal(
      await page
        .getByRole("status", { name: "草稿保存位置", exact: true })
        .innerText(),
      "已保存到服务器",
    );
    console.log(
      "PASS: no idle subtitle or premature empty-input errors; incomplete rows never upload, invalid text is shown, and completed valid input saves",
    );
  }
  const cases = {
    "pending-selection": checkPendingSelection,
    "refresh-state": checkRefreshState,
    "input-feedback": checkInputFeedback,
    "add-focus": checkAddFocus,
    "row-feedback": checkRowFeedback,
    "frame-shortcuts": checkFrameShortcuts,
    "save-recovery": () =>
      require("./workspace-save-recovery.cjs")({
        page,
        start,
        endInput,
        until,
        root,
        getServer: () => server,
        getWrites: () => writes,
        setFail: (value) => {
          fail = value;
        },
        setAcceptDialogs: (value) => {
          acceptDialogs = value;
        },
      }),
  };
  const selected = process.env.EDITOR_FRAGMENT
    ? [process.env.EDITOR_FRAGMENT]
    : Object.keys(cases);
  const results = Object.fromEntries(
    selected.map((name) => [name, { status: "not-run" }]),
  );
  try {
    await page.clock.install();
    for (const name of selected) {
      assert(cases[name], `Unknown workspace scenario: ${name}`);
      errors.length = 0;
      results[name].status = "running";
      try {
        await cases[name]();
        assert.deepEqual(errors, [], `${name}: browser runtime errors`);
        results[name].status = "passed";
      } catch (error) {
        results[name].status = "failed";
        throw error;
      } finally {
        fs.writeFileSync(
          path.join(session.artifactDir, "scenarios.json"),
          JSON.stringify(results, null, 2),
        );
      }
    }
  } catch (error) {
    await session.captureFailure(error);
    throw error;
  } finally {
    try {
      await session.close();
    } finally {
      fs.rmSync(previewPath, { force: true });
    }
  }
})().catch((e) => {
  fs.rmSync(previewPath, { force: true });
  console.error(e);
  process.exitCode = 1;
});
