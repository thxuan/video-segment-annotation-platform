// Actual App + mocked APIs. These checks never read or write acceptance data.
const { createBrowserSession } = require("./browser-session.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const baseUrl = process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173";
const output =
  process.env.TEST_ARTIFACT_DIR || path.join(root, ".cache/personal");
fs.mkdirSync(output, { recursive: true });
const clip = fs.readFileSync(path.join(root, "storage/videos/pusht-demo.mp4"));
const initial = () => ({
  id: "care-task",
  title: "推方块示教 · 片段标注",
  tenant_id: "care-tenant",
  tenant_name: "租户 A",
  duration_ms: 138000,
  status: "in_progress",
  assignee_id: "care-a1",
  assignee_name: "标注员 A1",
  created_at: "2026-10-23T01:00:00Z",
  submitted_at: null,
  revision: 1,
  segments: [
    { start_ms: 1000, end_ms: 3000 },
    { start_ms: 5000, end_ms: 10000 },
  ],
  effective_ms: 7000,
});

(async () => {
  const session = await createBrowserSession(
    "personal",
    {
      width: 1440,
      height: 1000,
    },
    { hasTouch: true },
  );
  const { context, page } = session;
  let task = initial(),
    mode = "ready",
    submitMode = "ready",
    count = 127,
    writes = 0,
    reads = 0;
  let emptyTaskList = false;
  let effectiveMs = 13_338_000;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  let failedYear = null;
  const report = (year = null) => ({
    timezone: "Asia/Shanghai",
    year,
    years: [2025, 2024, 2023],
    as_of: "2026-10-23",
    start_date: year === null ? "2025-10-24" : `${year}-01-01`,
    end_date: year === null ? "2026-10-23" : `${year}-12-31`,
    task_count: mode === "empty" ? 0 : count,
    effective_ms: mode === "empty" ? 0 : effectiveMs,
    today_count: mode === "empty" ? 0 : task.status === "submitted" ? 6 : 5,
    active_days: mode === "empty" ? 0 : 26,
    items:
      mode === "empty"
        ? []
        : year === 2025 || year === 2023
          ? []
          : year !== null
            ? [{ date: `${year}-02-29`, task_count: 2, effective_ms: 3000 }]
            : Array.from({ length: 26 }, (_, index) => ({
                date: new Date(Date.UTC(2026, 9, 23) - index * 13 * 86400000)
                  .toISOString()
                  .slice(0, 10),
                task_count:
                  index === 0 && task.status === "submitted"
                    ? 6
                    : index < 23
                      ? 5
                      : 4,
                effective_ms: index * 10000 + 5000,
              })),
  });
  await context.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "care-a1",
            username: "a1",
            display_name: "标注员 A1",
            role: "annotator",
            tenant_id: "care-tenant",
            tenant_name: "租户 A",
          },
          csrf_token: "mock-only",
        },
      });
    if (url.pathname === "/api/stats/me") {
      reads++;
      return mode === "error" ||
        Number(url.searchParams.get("year")) === failedYear
        ? route.fulfill({ status: 503, json: { detail: "模拟统计读取失败" } })
        : route.fulfill({
            json: report(
              url.searchParams.has("year")
                ? Number(url.searchParams.get("year"))
                : null,
            ),
          });
    }
    if (url.pathname === "/api/tasks" && emptyTaskList)
      return route.fulfill({
        json: { items: [], total: 0, page: 1, page_size: 10 },
      });
    if (url.pathname === "/api/tasks")
      return route.fulfill({
        json: {
          items:
            url.searchParams.get("status") === "in_progress" &&
            task.status === "submitted"
              ? []
              : [task],
          total:
            task.status === "submitted" &&
            url.searchParams.get("status") === "in_progress"
              ? 0
              : 1,
          page: 1,
          page_size: 10,
        },
      });
    if (url.pathname === "/api/tasks/care-task")
      return route.fulfill({ json: task });
    if (url.pathname.endsWith("/frames"))
      return route.fulfill({
        json: { frame_times_ms: [0, 1000, 3000, 5000, 10000] },
      });
    if (url.pathname.endsWith("/video")) {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range || "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]), clip.length - 1)
        : clip.length - 1;
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
    if (url.pathname.endsWith("/submit")) {
      writes++;
      if (submitMode === "error")
        return route.fulfill({ status: 503, json: { detail: "模拟提交失败" } });
      if (task.status !== "submitted") count++;
      task = {
        ...task,
        status: "submitted",
        revision: 2,
        submitted_at: "2026-10-23T06:00:00Z",
      };
      return route.fulfill({ json: task });
    }
    throw new Error(`Unexpected mock ${req.method()} ${url.pathname}`);
  });
  const screenshot = (name) =>
    page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const noOverflow = async () =>
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  const openStats = async () => {
    await page.getByRole("button", { name: "个人统计", exact: true }).click();
    await page
      .getByRole("heading", { name: "个人统计", exact: true })
      .waitFor();
  };
  const openTask = async () => {
    await page.evaluate(() => {
      sessionStorage.setItem(
        "annotation-page-v1:care-a1",
        JSON.stringify({ view: "tasks", selectedId: "care-task" }),
      );
    });
    await page.reload();
    await page.getByRole("button", { name: "提交任务", exact: true }).waitFor();
  };
  const reset = async () => {
    task = initial();
    mode = "ready";
    submitMode = "ready";
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("annotation-draft-v1:care-a1:"))
          localStorage.removeItem(key);
    });
    await openTask();
  };
  const submit = async () => {
    await page.getByRole("button", { name: "提交任务", exact: true }).click();
    await page.getByRole("dialog").waitFor();
  };
  try {
    await page.goto(baseUrl);
    await openStats();
    await page.locator(".activity-grid button").last().waitFor();
    assert.equal(await page.locator(".activity-grid button").count(), 365);
    assert.equal(
      await page.getByRole("combobox", { name: "选择时间范围" }).inputValue(),
      "recent",
    );
    assert.equal(
      await page.getByRole("option", { name: "2026 年", exact: true }).count(),
      0,
    );
    assert.deepEqual(
      await page
        .locator(".activity-months span")
        .allTextContents()
        .then((values) => values.filter(Boolean)),
      [
        "11月",
        "12月",
        ...Array.from({ length: 10 }, (_, index) => `${index + 1}月`),
      ],
    );
    assert.equal(
      await page.getByText("属于你的积累", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByText("每一份认真，都在这里留下记录。", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.locator(".activity-weekdays, .personal-note").count(),
      0,
    );
    assert.equal(
      await page
        .locator(".personal-metric")
        .first()
        .innerText()
        .then((t) => t.includes("127")),
      true,
    );
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "个人统计", exact: true })
        .innerText(),
      "个人统计",
    );
    assert.equal(await page.locator(".personal-nav-count").count(), 0);
    await screenshot("personal-dark");
    await page.getByRole("button", { name: "浅色模式", exact: true }).click();
    await screenshot("personal-light");
    await page.locator(".activity-grid button").last().focus();
    await page.keyboard.press("ArrowLeft");
    assert(
      (await page.locator(".activity-footer").innerText()).includes(
        "2026-10-16",
      ),
    );
    await page.keyboard.press("Home");
    assert(
      (await page.locator(".activity-footer").innerText()).includes(
        "2025-10-24",
      ),
    );
    const lifetime = await page.locator(".personal-metrics").innerText();
    await page
      .getByRole("combobox", { name: "选择时间范围" })
      .selectOption("2024");
    await page.getByRole("button", { name: /^2024-02-29/ }).waitFor();
    assert.equal(await page.locator(".activity-grid button").count(), 366);
    assert.deepEqual(
      await page
        .locator(".activity-months span")
        .allTextContents()
        .then((values) => values.filter(Boolean)),
      Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
    );
    assert.equal(await page.locator(".personal-metrics").innerText(), lifetime);
    await page
      .getByRole("combobox", { name: "选择时间范围" })
      .selectOption("2025");
    await page.getByText("2025 年暂无提交记录。", { exact: true }).waitFor();
    assert.equal(await page.locator(".activity-grid button").count(), 365);
    failedYear = 2023;
    await page
      .getByRole("combobox", { name: "选择时间范围" })
      .selectOption("2023");
    await page.getByText("暂时无法加载该年份的记录", { exact: true }).waitFor();
    assert.equal(await page.locator(".personal-metrics").innerText(), lifetime);
    assert.equal(await page.locator(".activity-grid").count(), 0);
    failedYear = null;
    await page
      .getByRole("button", { name: "重试年度记录", exact: true })
      .click();
    await page.getByText("2023 年暂无提交记录。", { exact: true }).waitFor();
    await page
      .getByRole("combobox", { name: "选择时间范围" })
      .selectOption("recent");
    await page.getByRole("button", { name: /^2026-10-23/ }).waitFor();
    await page.reload();
    await page
      .getByRole("heading", { name: "个人统计", exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("personal-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    count = 12999;
    effectiveMs = 451818255;
    await page.getByRole("button", { name: "刷新统计", exact: true }).click();
    const taskMetric = page.getByRole("button", {
      name: "累计完成，完整数值：12,999 项",
      exact: true,
    });
    const timeMetric = page.getByRole("button", {
      name: "累计有效时长，完整数值：125 小时 30 分 18.255 秒",
      exact: true,
    });
    await taskMetric.waitFor();
    assert(
      (await taskMetric.innerText()).replace(/\s/g, "").includes("1.2万项"),
    );
    assert(
      (await timeMetric.innerText()).replace(/\s/g, "").includes("125.5小时"),
    );
    await taskMetric.hover();
    await page.getByRole("tooltip").waitFor();
    assert.equal(await page.getByRole("tooltip").innerText(), "12,999 项");
    await page.keyboard.press("Escape");
    await page.getByRole("tooltip").waitFor({ state: "detached" });
    await taskMetric.focus();
    await page.getByRole("tooltip").waitFor();
    await page.keyboard.press("Escape");
    await taskMetric.press("Enter");
    await page.getByRole("tooltip").waitFor();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.getByRole("tooltip").innerText(),
      "125 小时 30 分 18.255 秒",
    );
    assert.equal(await page.getByRole("tooltip").count(), 1);
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await timeMetric.hover();
    await screenshot("personal-large-dark");
    await page.getByRole("button", { name: "浅色模式", exact: true }).click();
    await taskMetric.hover();
    await screenshot("personal-large-light");
    await page.setViewportSize({ width: 390, height: 844 });
    await timeMetric.tap();
    await page.getByRole("tooltip").waitFor();
    assert.equal(
      await page.getByRole("tooltip").innerText(),
      "125 小时 30 分 18.255 秒",
    );
    const tooltipBox = await page.getByRole("tooltip").boundingBox();
    assert(tooltipBox.x >= 0 && tooltipBox.x + tooltipBox.width <= 390);
    await screenshot("personal-large-mobile");
    await page.getByRole("heading", { name: "个人统计", exact: true }).tap();
    await page.getByRole("tooltip").waitFor({ state: "detached" });
    count = Number.MAX_SAFE_INTEGER;
    effectiveMs = Number.MAX_SAFE_INTEGER;
    await page.getByRole("button", { name: "刷新统计", exact: true }).click();
    await page
      .getByRole("button", {
        name: "累计完成，完整数值：9,007,199,254,740,991 项",
        exact: true,
      })
      .waitFor();
    for (const width of [1440, 900, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow();
      assert.equal(
        await page
          .locator(".personal-metric-value strong")
          .evaluateAll((nodes) =>
            nodes.every((node) => {
              const bounds = node.getBoundingClientRect();
              const card = node
                .closest(".personal-metric")
                .getBoundingClientRect();
              return (
                bounds.left >= card.left &&
                bounds.right <= card.right &&
                getComputedStyle(node).whiteSpace === "nowrap"
              );
            }),
          ),
        true,
        `large values fit their cards at ${width}px`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    count = 127;
    effectiveMs = 13_338_000;
    await page.getByRole("button", { name: "刷新统计", exact: true }).click();
    await page
      .getByRole("button", { name: "累计完成，完整数值：127 项", exact: true })
      .waitFor();
    console.log(
      "PASS: compact values retain exact millisecond details, hover/focus/Enter/Escape/touch work, and largest safe values fit desktop/tablet/mobile cards",
    );
    mode = "error";
    await page.getByRole("button", { name: "刷新统计", exact: true }).click();
    await page.getByRole("heading", { name: "暂时无法加载统计" }).waitFor();
    assert.equal(await page.locator(".personal-metric").count(), 0);
    mode = "empty";
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page
      .getByText("最近 365 天暂无提交记录。", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".activity-grid .level-0").count(), 365);
    console.log(
      "PASS: default rolling 365 days, historical January–December years, leap/empty years, unchanged lifetime totals, retries and both themes",
    );

    emptyTaskList = true;
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.getByText("暂无标注中的任务", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "查看全部任务", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "这里暂时没有任务", exact: true })
      .waitFor();
    await openStats();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "查看全部任务", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "这里暂时没有任务", exact: true })
      .waitFor();
    await noOverflow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    emptyTaskList = false;
    console.log(
      "PASS: permanent all-tasks entry returns from statistics with no tasks on desktop/mobile; personal navigation has no count",
    );
    mode = "ready";
    await openTask();
    // Existing unsaved-change protection also covers the new statistics entry.
    await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
    await page.getByLabel("片段 1 终点", { exact: true }).fill("3.5");
    page.removeAllListeners("dialog");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "个人统计", exact: true }).click();
    assert.equal(await page.locator(".editor-header").count(), 1);
    page.on("dialog", (dialog) => dialog.accept());
    await reset();
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await submit();
    await page
      .getByText("累计完成", { exact: false })
      .filter({ has: page.locator("strong") })
      .waitFor();
    await page.waitForTimeout(1200);
    const box = await page.getByRole("dialog").boundingBox();
    assert(Math.abs(box.x + box.width / 2 - 720) < 2);
    assert(Math.abs(box.y + box.height / 2 - 500) < 2);
    await screenshot("submission-dark");
    assert.equal(
      await page.getByRole("dialog").getByText("128", { exact: true }).count(),
      1,
    );
    await page.getByRole("checkbox", { name: "播放庆祝动效" }).uncheck();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "完成", exact: true })
      .focus();
    await page.keyboard.press("Space");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(
      await page.locator("video").evaluate((video) => video.paused),
      true,
    );
    await page.reload();
    await page.getByText("已提交，片段只读。", { exact: false }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await openStats();
    assert(
      (await page.locator(".personal-metric").first().innerText()).includes(
        "128",
      ),
    );
    console.log(
      "PASS: confirmed submission opens a centered modal, refreshes totals, pauses video and supports Space without replay on refresh",
    );

    await reset();
    await page.getByRole("button", { name: "浅色模式", exact: true }).click();
    await submit();
    assert.equal(
      await page.getByRole("checkbox", { name: "播放庆祝动效" }).isChecked(),
      false,
    );
    assert.equal(await page.locator(".celebration-animated").count(), 0);
    await screenshot("submission-light");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("submission-mobile");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await reset();
    count = 99;
    await submit();
    await page
      .getByRole("heading", { name: "已完成第 100 项标注", exact: true })
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "返回任务列表", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "我的任务", exact: true })
      .waitFor();
    console.log(
      "PASS: motion preference persists, light/mobile modal layout, Escape, milestone and return-to-list actions",
    );

    await reset();
    submitMode = "error";
    await page.getByRole("button", { name: "提交任务", exact: true }).click();
    await page
      .getByRole("button", { name: "重试相同提交", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    submitMode = "ready";
    mode = "error";
    await page
      .getByRole("button", { name: "重试相同提交", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.locator(".celebration-total").count(), 0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "完成", exact: true })
      .click();

    // Native fullscreen and reduced-motion remain usable with the new modal.
    await reset();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "全屏播放", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    // Submit control is outside native fullscreen; exercise its same action handler.
    await page
      .getByRole("button", { name: "提交任务", exact: true })
      .evaluate((button) => button.click());
    await page.getByRole("dialog").waitFor();
    await page.getByRole("checkbox", { name: "播放庆祝动效" }).check();
    assert.equal(
      await page
        .locator(".celebration-confetti")
        .first()
        .evaluate((el) => getComputedStyle(el).display),
      "none",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await page.evaluate(() => document.exitFullscreen());
    assert(reads > 0 && writes === 6);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: submit/summary failures never fabricate success/counts; fullscreen and reduced-motion modal work without runtime errors",
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
