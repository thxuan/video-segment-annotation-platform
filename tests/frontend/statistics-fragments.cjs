// Statistics UI checks with mocked APIs; never contact the acceptance database.
const { createBrowserSession } = require("./browser-session.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const name = `statistics-fragments-${process.pid}.html`;
const previewPath = path.join(root, "src/frontend/.cache", name);
fs.mkdirSync(path.dirname(previewPath), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "fixtures/statistics-preview.html"),
  previewPath,
);

(async () => {
  const session = await createBrowserSession("statistics", {
    width: 1200,
    height: 1000,
  });
  const { page } = session;
  const errors = [];
  const dailyRequests = [];
  const taskRequests = [];
  let bMode = "error";
  let navigationMode = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET");
    if (url.pathname.endsWith("/frames"))
      return route.fulfill({ json: { frame_times_ms: [0, 100, 200] } });
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: { id: "mock-admin", role: "admin", display_name: "管理员" },
          csrf_token: "mock-only",
        },
      });
    if (url.pathname === "/api/tasks")
      return route.fulfill({
        json: { items: [], total: 0, page: 1, page_size: 10 },
      });
    if (url.pathname === "/api/tasks/task-B1")
      return route.fulfill({
        json: {
          id: "task-B1",
          title: "B1 任务详情",
          tenant_id: "tenant-b",
          tenant_name: "租户 B",
          duration_ms: 120000,
          status: "submitted",
          assignee_id: "B1",
          assignee_name: "标注员 B1",
          created_at: "2026-10-20T01:00:00Z",
          submitted_at: "2026-10-20T02:00:00Z",
          revision: 7,
          segments: [{ start_ms: 0, end_ms: 60000 }],
          effective_ms: 60000,
        },
      });
    if (url.pathname.endsWith("/video"))
      return route.fulfill({
        status: 404,
        body: "No media in navigation check",
      });
    if (url.pathname === "/api/tenants")
      return route.fulfill({
        json: [
          { id: "tenant-a", name: "租户 A" },
          { id: "tenant-b", name: "租户 B" },
        ],
      });
    if (url.pathname === "/api/stats/daily") {
      const params = Object.fromEntries(url.searchParams);
      dailyRequests.push(params);
      if (params.tenant_id === "tenant-b" && bMode === "error")
        return route.fulfill({
          status: 503,
          json: { detail: "模拟租户 B 查询失败" },
        });
      const tenant = params.tenant_id === "tenant-b" ? "b" : "a";
      const users = tenant === "a" ? ["A1", "A2"] : ["B1"];
      const items =
        tenant === "b" && bMode === "empty"
          ? []
          : users.map((user) => ({
              date: params.start_date,
              tenant_id: `tenant-${tenant}`,
              tenant_name: `租户 ${tenant.toUpperCase()}`,
              user_id: user,
              user_name: `标注员 ${user}`,
              task_count: 1,
              effective_ms: 60000,
            }));
      return route.fulfill({
        json: {
          timezone: "Asia/Shanghai",
          start_date: params.start_date,
          end_date: params.end_date,
          items,
          task_count: items.length,
          effective_ms: items.length * 60000,
        },
      });
    }
    if (url.pathname === "/api/stats/tasks") {
      const params = Object.fromEntries(url.searchParams);
      taskRequests.push(params);
      return route.fulfill({
        json: {
          total: navigationMode ? 2 : 1,
          page_size: navigationMode ? 1 : 20,
          items: [
            {
              id: `task-${params.user_id}`,
              title: `${params.user_id} 的已提交任务`,
              submitted_at: `${params.day}T02:00:00Z`,
              effective_ms: 60000,
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected API: ${url.pathname}`);
  });
  try {
    await page.goto(
      `${process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173"}/.cache/${name}`,
    );
    await page
      .getByRole("button", { name: "查看任务", exact: true })
      .first()
      .waitFor();
    const search = page.getByRole("button", { name: "查询", exact: true });
    await page.getByLabel("租户", { exact: true }).selectOption("tenant-a");
    await search.click();
    await page.getByText(/当前结果：.*租户 A/).waitFor();
    assert.equal(dailyRequests.at(-1).tenant_id, "tenant-a");
    const a1 = page
      .locator("tr")
      .filter({ has: page.getByText("标注员 A1", { exact: true }) });
    const a2 = page
      .locator("tr")
      .filter({ has: page.getByText("标注员 A2", { exact: true }) });
    await a1.getByRole("button", { name: "查看任务", exact: true }).click();
    await page.getByText("A1 的已提交任务", { exact: true }).waitFor();
    assert.equal(
      await a1.evaluate((el) =>
        el.nextElementSibling.classList.contains("stats-detail-row"),
      ),
      true,
    );
    assert.equal(
      await a1.getByRole("button").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(taskRequests.at(-1).tenant_id, "tenant-a");
    assert.equal(taskRequests.at(-1).user_id, "A1");
    await page.getByRole("button", { name: "查看片段", exact: true }).click();
    assert.equal(await page.evaluate(() => window.selectedTask), "task-A1");
    await a2.getByRole("button", { name: "查看任务", exact: true }).click();
    await page.getByText("A2 的已提交任务", { exact: true }).waitFor();
    assert.equal(await page.locator(".stats-detail").count(), 1);
    assert.equal(
      await page.getByText("A1 的已提交任务", { exact: true }).count(),
      0,
    );
    await page.screenshot({
      path: `${root}/.cache/statistics-inline.png`,
      fullPage: true,
    });
    await a2.getByRole("button", { name: "收起任务", exact: true }).click();
    assert.equal(await page.locator(".stats-detail").count(), 0);
    await a1.getByRole("button", { name: "查看任务", exact: true }).click();

    await page.getByLabel("租户", { exact: true }).selectOption("tenant-b");
    await search.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "模拟租户 B 查询失败" })
      .waitFor();
    assert.equal(dailyRequests.at(-1).tenant_id, "tenant-b");
    assert.equal(
      await page.locator(".summary-cards, .stats-detail").count(),
      0,
    );
    assert.equal(await page.getByText("标注员 A1", { exact: true }).count(), 0);
    bMode = "empty";
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page
      .getByText("该日期范围内尚无已提交任务。", { exact: true })
      .waitFor();
    assert.match(
      await page.locator(".summary-cards").innerText(),
      /00:00:00.000/,
    );
    assert.match(await page.getByText(/当前结果：/).innerText(), /租户 B/);
    bMode = "success";
    await search.click();
    await page.getByText("标注员 B1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await page.getByText("B1 的已提交任务", { exact: true }).waitFor();
    assert.equal(taskRequests.at(-1).tenant_id, "tenant-b");
    assert.equal(taskRequests.at(-1).user_id, "B1");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: `${root}/.cache/statistics-inline-mobile.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-20");
    await page.getByLabel("结束日期", { exact: true }).fill("2026-10-21");
    await search.click();
    await page.getByText(/当前结果：2026-10-20 至 2026-10-21/).waitFor();
    assert.equal(dailyRequests.at(-1).start_date, "2026-10-20");
    assert.equal(dailyRequests.at(-1).end_date, "2026-10-21");
    assert.equal(await page.locator(".stats-detail").count(), 0);
    navigationMode = true;
    await page.setViewportSize({ width: 1200, height: 650 });
    await page.goto(
      `${process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173"}/.cache/${name}?app=1`,
    );
    await page.getByRole("button", { name: "每日统计", exact: true }).click();
    await page.getByLabel("租户", { exact: true }).selectOption("tenant-b");
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-20");
    await page.getByLabel("结束日期", { exact: true }).fill("2026-10-21");
    await search.click();
    await page.getByText("标注员 B1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByText("第 2 页", { exact: true }).waitFor();
    await page.getByText("B1 的已提交任务", { exact: true }).waitFor();
    // Preserve unsubmitted form edits separately from the applied query.
    await page.getByLabel("结束日期", { exact: true }).fill("2026-10-22");
    const open = page.getByRole("button", { name: "查看片段", exact: true });
    await open.scrollIntoViewIfNeeded();
    const oldY = await page.evaluate(() => window.scrollY);
    assert(oldY > 0);
    const queryCount = dailyRequests.length;
    const detailCount = taskRequests.length;
    await open.click();
    await page
      .getByRole("heading", { name: "B1 任务详情", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "每日有效时长", exact: true })
        .isVisible(),
      false,
    );
    await page
      .getByRole("button", { name: "返回每日统计", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "每日有效时长", exact: true })
      .waitFor();
    assert(Math.abs((await page.evaluate(() => window.scrollY)) - oldY) <= 1);
    assert.equal(
      await page.getByLabel("租户", { exact: true }).inputValue(),
      "tenant-b",
    );
    assert.equal(
      await page.getByLabel("开始日期", { exact: true }).inputValue(),
      "2026-10-20",
    );
    assert.equal(
      await page.getByLabel("结束日期", { exact: true }).inputValue(),
      "2026-10-22",
    );
    assert.match(
      await page.getByText(/当前结果：/).innerText(),
      /2026-10-20 至 2026-10-21.*租户 B/,
    );
    assert.equal(
      await page.getByText("第 2 页", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "收起任务", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await open.evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(dailyRequests.length, queryCount);
    assert.equal(taskRequests.length, detailCount);
    assert.equal(taskRequests.at(-1).page, "2");
    for (const destination of ["tasks", "publish"]) {
      await page.getByRole("button", { name: "任务管理", exact: true }).click();
      await page
        .getByRole("heading", { name: "所有任务", exact: true })
        .waitFor();
      if (destination === "publish") {
        await page
          .getByRole("button", { name: "发布任务", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "发布任务", exact: true })
          .waitFor();
      }
      await page.getByRole("button", { name: "每日统计", exact: true }).click();
      await page
        .getByRole("heading", { name: "每日有效时长", exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel("开始日期", { exact: true }).inputValue(),
        "2026-10-20",
      );
      assert.equal(
        await page.getByLabel("结束日期", { exact: true }).inputValue(),
        "2026-10-22",
      );
      assert.equal(
        await page.getByLabel("租户", { exact: true }).inputValue(),
        "tenant-b",
      );
      assert.match(
        await page.getByText(/当前结果：/).innerText(),
        /2026-10-20 至 2026-10-21.*租户 B/,
      );
      assert.equal(
        await page.getByText("第 2 页", { exact: true }).isVisible(),
        true,
      );
      assert.equal(dailyRequests.length, queryCount);
      assert.equal(taskRequests.length, detailCount);
    }
    console.log(
      "PASS: switching to task management/publishing retains draft dates, applied results, tenant and expanded task page without refetch",
    );
    await search.click();
    await page.getByText(/当前结果：2026-10-20 至 2026-10-22/).waitFor();
    assert.equal(await page.locator(".stats-detail").count(), 0);
    console.log(
      "PASS: actual App detail return preserves draft/applied filters, results, expanded row, page 2, scroll and focus without refetch; explicit query still updates",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: query button applies tenant/date filters; B failure and empty results replace A; inline details toggle under their parent, use scoped requests and navigate to the task; no mobile page overflow",
    );
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
})().catch((error) => {
  fs.rmSync(previewPath, { force: true });
  console.error(error);
  process.exitCode = 1;
});
