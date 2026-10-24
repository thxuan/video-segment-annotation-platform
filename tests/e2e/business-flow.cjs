// Real production bundle + API + PostgreSQL. Deliberately no page.route mocks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../..");
const frontendRequire = createRequire(
  path.join(root, "src/frontend/package.json"),
);
const { chromium } = frontendRequire("playwright");
const baseURL = process.env.AUTOMATION_BASE_URL;
assert(
  ["http://127.0.0.1:5184", "http://127.0.0.1:5880"].includes(baseURL),
  "Refusing non-test browser target",
);
assert.equal(
  process.env.RUN_AUTOMATION_DB_TESTS,
  "1",
  "Use tools/run_automation.py",
);
const config = fs.readFileSync(
  path.join(root, ".cache/automation-tests.env"),
  "utf8",
);
const password = /^AUTOMATION_DEMO_PASSWORD=(.+)$/m.exec(config)?.[1].trim();
assert(password, "Missing isolated demo credentials");
const output = process.env.TEST_ARTIFACT_DIR;
assert(output, "Test artifacts directory is required");
fs.mkdirSync(output, { recursive: true });
const scenarios = [];

async function main() {
  const browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  fs.writeFileSync(
    path.join(output, "runtime.json"),
    JSON.stringify(
      {
        node: process.version,
        playwright: frontendRequire("playwright/package.json").version,
        browser: browser.version(),
        baseURL,
      },
      null,
      2,
    ),
  );
  const contexts = [];
  const errors = [];
  const pages = [];
  async function actor(name) {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context);
    context.setDefaultTimeout(15000);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/");
    await page.getByRole("heading", { name: "登录工作区" }).waitFor();
    await page.getByLabel("账号", { exact: true }).fill(name);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入工作区" }).click();
    await page
      .getByRole("heading", {
        name: name === "admin" ? "所有任务" : "我的任务",
        exact: true,
      })
      .waitFor();
    return page;
  }
  async function scenario(name, run) {
    const entry = { name, status: "running" };
    scenarios.push(entry);
    try {
      await run();
      entry.status = "passed";
      console.log(`PASS: ${name}`);
    } catch (error) {
      entry.status = "failed";
      throw error;
    }
  }
  async function json(page, url) {
    const response = await page.request.get(url);
    assert.equal(response.status(), 200, url);
    return response.json();
  }
  let failed = false;
  try {
    const admin = await actor("admin");
    const title = `自动化闭环-${Date.now()}`;
    let task, tenant;
    await scenario("管理员真实上传与视频播放", async () => {
      tenant = (await json(admin, "/api/tenants")).find(
        (item) => item.name === "租户 A",
      );
      await admin
        .getByRole("button", { name: "发布任务", exact: true })
        .click();
      await admin
        .getByRole("combobox", { name: /^所属租户/ })
        .selectOption(tenant.id);
      await admin
        .locator('input[type="file"]')
        .setInputFiles(
          path.join(root, ".cache/automation-videos/pusht-demo.mp4"),
        );
      await admin
        .getByRole("button", { name: "编辑任务 1 标题", exact: true })
        .click();
      const taskTitle = admin.getByLabel("任务 1 标题", { exact: true });
      await taskTitle.fill(title);
      await taskTitle.press("Enter");
      const created = admin.waitForResponse(
        (r) =>
          r.url().includes("/api/tasks?") && r.request().method() === "POST",
      );
      await admin
        .getByRole("button", { name: "发布任务", exact: true })
        .click();
      const response = await created;
      assert.equal(response.status(), 201);
      // Read actual persistence through an independent authenticated request.
      const published = (
        await json(admin, "/api/tasks?page_size=100")
      ).items.filter((item) => item.title === title);
      assert.equal(published.length, 1);
      task = published[0];
      await admin
        .locator(".publish-file-list")
        .getByRole("button", { name: "查看任务", exact: true })
        .click();
      await admin.getByRole("heading", { name: title, exact: true }).waitFor();
      await admin.waitForFunction(
        () => document.querySelector("video")?.readyState >= 2,
      );
      await admin.getByRole("button", { name: "播放", exact: true }).click();
      await admin.waitForFunction(() => {
        const video = document.querySelector("video");
        return video && !video.paused && video.currentTime > 0.05;
      });
      await admin.getByRole("button", { name: "暂停", exact: true }).click();
      assert(task.duration_ms > 10000);
    });
    const annotator = await actor("a1");
    const otherTenant = await actor("b1");
    await scenario("跨租户列表与视频隔离", async () => {
      const list = await json(otherTenant, "/api/tasks");
      assert(!list.items.some((item) => item.id === task.id));
      assert.equal(
        await otherTenant.getByText(title, { exact: true }).count(),
        0,
      );
      for (const suffix of ["", "/video", "/frames"]) {
        const denied = await otherTenant.request.get(
          `/api/tasks/${task.id}${suffix}`,
        );
        assert.equal(denied.status(), 404);
      }
    });
    await scenario("领取、标注、保存与刷新持久化；草稿不计统计", async () => {
      await annotator
        .getByRole("button", { name: title, exact: false })
        .click();
      await annotator
        .getByRole("button", { name: "领取并开始标注", exact: true })
        .click();
      await annotator.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
      await annotator
        .getByRole("button", { name: "添加片段", exact: true })
        .click();
      await annotator.getByLabel("片段 1 起点", { exact: true }).fill("1");
      await annotator.getByLabel("片段 1 终点", { exact: true }).fill("3");
      await annotator
        .getByRole("button", { name: "添加片段", exact: true })
        .click();
      await annotator.getByLabel("片段 2 起点", { exact: true }).fill("5");
      await annotator.getByLabel("片段 2 终点", { exact: true }).fill("10");
      const saved = annotator.waitForResponse(
        (r) =>
          r.url().endsWith(`/tasks/${task.id}/segments`) &&
          r.request().method() === "PUT",
      );
      await annotator
        .getByRole("button", { name: "立即保存", exact: true })
        .click();
      assert.equal((await saved).status(), 200);
      await annotator
        .getByRole("status", { name: "草稿保存位置", exact: true })
        .filter({ hasText: "已保存到服务器" })
        .waitFor();
      await annotator.reload();
      await annotator.getByLabel("片段 2 终点", { exact: true }).waitFor();
      assert.equal(
        Number(
          await annotator
            .getByLabel("片段 1 起点", { exact: true })
            .inputValue(),
        ),
        1,
      );
      assert.equal(
        Number(
          await annotator
            .getByLabel("片段 2 终点", { exact: true })
            .inputValue(),
        ),
        10,
      );
      const personal = await json(annotator, "/api/stats/me");
      assert.equal(personal.task_count, 0);
      assert.equal(personal.effective_ms, 0);
      const stats = await json(
        admin,
        `/api/stats/daily?start_date=${personal.as_of}&end_date=${personal.as_of}&tenant_id=${tenant.id}`,
      );
      assert.equal(stats.task_count, 0);
    });
    let submitted, submissionDay;
    await scenario("提交锁定与个人统计刷新", async () => {
      const response = annotator.waitForResponse(
        (r) =>
          r.url().endsWith(`/tasks/${task.id}/submit`) &&
          r.request().method() === "POST",
      );
      await annotator
        .getByRole("button", { name: "提交任务", exact: true })
        .click();
      const result = await response;
      assert.equal(result.status(), 200);
      submitted = await json(annotator, `/api/tasks/${task.id}`);
      submissionDay = new Date(Date.parse(submitted.submitted_at) + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      assert.equal(submitted.effective_ms, 7000);
      await annotator
        .getByText("已提交，片段只读。", { exact: false })
        .waitFor();
      await annotator
        .getByRole("button", { name: "关闭成功提示", exact: true })
        .click();
      await annotator
        .getByRole("button", { name: "个人统计", exact: true })
        .click();
      await annotator
        .getByRole("heading", { name: "个人统计", exact: true })
        .waitFor();
      await annotator
        .getByRole("region", { name: "个人累计成果", exact: true })
        .waitFor();
      const personal = await json(annotator, "/api/stats/me");
      assert.deepEqual(
        [
          personal.task_count,
          personal.effective_ms,
          personal.today_count,
          personal.active_days,
        ],
        [1, 7000, personal.as_of === submissionDay ? 1 : 0, 1],
      );
      await annotator
        .getByRole("button", { name: "累计完成，完整数值：1 项", exact: true })
        .waitFor();
      await annotator
        .getByRole("button", {
          name: "累计有效时长，完整数值：0 小时 0 分 7.000 秒",
          exact: true,
        })
        .waitFor();
    });
    await scenario("管理员统计与片段追溯一致", async () => {
      await admin
        .getByRole("button", { name: "每日统计", exact: true })
        .click();
      await admin
        .getByRole("heading", { name: "每日有效时长", exact: true })
        .waitFor();
      const day = submissionDay;
      await admin.getByLabel("开始日期", { exact: true }).fill(day);
      await admin.getByLabel("结束日期", { exact: true }).fill(day);
      await admin.getByLabel("租户", { exact: true }).selectOption(tenant.id);
      await admin.getByRole("button", { name: "查询", exact: true }).click();
      await admin
        .locator(".summary-cards")
        .getByText("00:00:07.000", { exact: true })
        .waitFor();
      await admin
        .getByRole("button", { name: "查看任务", exact: true })
        .click();
      const row = admin.locator(".stats-detail tr").filter({ hasText: title });
      await row.getByRole("button", { name: "查看片段", exact: true }).click();
      await admin.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.equal(
        await admin
          .getByRole("button", { name: "提交任务", exact: true })
          .count(),
        0,
      );
      const detail = await json(admin, `/api/tasks/${task.id}`);
      assert.deepEqual(detail.segments, [
        { start_ms: 1000, end_ms: 3000 },
        { start_ms: 5000, end_ms: 10000 },
      ]);
      assert.equal(detail.submitted_at, submitted.submitted_at);
    });
    await scenario(
      "真实多视频发布、租户权限与每日统计跨页日期保留",
      async () => {
        await admin
          .getByRole("button", { name: "返回每日统计", exact: true })
          .click();
        await admin.getByLabel("开始日期", { exact: true }).fill("2026-01-01");
        await admin.getByLabel("结束日期", { exact: true }).fill("2026-01-31");
        await admin
          .getByRole("button", { name: "任务管理", exact: true })
          .click();
        await admin
          .getByRole("button", { name: "发布任务", exact: true })
          .click();
        const tenantB = (await json(admin, "/api/tenants")).find(
          (item) => item.name === "租户 B",
        );
        await admin
          .getByRole("combobox", { name: /^所属租户/ })
          .selectOption(tenantB.id);
        const prefix = `自动化批量-${Date.now()}`;
        const video = fs.readFileSync(
          path.join(root, ".cache/automation-videos/pusht-demo.mp4"),
        );
        await admin.locator('input[type="file"]').setInputFiles(
          [1, 2].map((index) => ({
            name: `${prefix}-${index}.mp4`,
            mimeType: "video/mp4",
            buffer: video,
          })),
        );
        await admin
          .getByRole("button", { name: "发布任务", exact: true })
          .click();
        await admin.getByText("全部发布完成", { exact: true }).waitFor();
        const batch = (
          await json(admin, "/api/tasks?page_size=100")
        ).items.filter((item) => item.title.startsWith(prefix));
        assert.equal(batch.length, 2);
        assert.deepEqual(batch.map((item) => item.title).sort(), [
          `${prefix}-1`,
          `${prefix}-2`,
        ]);
        assert(
          batch.every(
            (item) =>
              item.tenant_id === tenantB.id &&
              item.status === "available" &&
              item.duration_ms > 10000,
          ),
        );
        const bList = (await json(otherTenant, "/api/tasks?page_size=100"))
          .items;
        for (const item of batch) {
          assert(bList.some((visible) => visible.id === item.id));
          assert.equal(
            (await annotator.request.get(`/api/tasks/${item.id}`)).status(),
            404,
          );
        }
        await admin
          .getByRole("button", { name: "每日统计", exact: true })
          .click();
        assert.equal(
          await admin.getByLabel("开始日期", { exact: true }).inputValue(),
          "2026-01-01",
        );
        assert.equal(
          await admin.getByLabel("结束日期", { exact: true }).inputValue(),
          "2026-01-31",
        );
        assert.equal(
          await admin.getByLabel("租户", { exact: true }).inputValue(),
          tenant.id,
        );
        await admin
          .getByText(
            new RegExp(`当前结果：${submissionDay} 至 ${submissionDay}`),
          )
          .waitFor();
        await admin
          .locator(".summary-cards")
          .getByText("00:00:07.000", { exact: true })
          .waitFor();
      },
    );
    await scenario("退出撤销与同浏览器账号切换清理缓存", async () => {
      const oldCookies = await annotator
        .context()
        .cookies(baseURL + "/api/auth/me");
      await annotator
        .getByRole("button", { name: "退出登录", exact: true })
        .click();
      await annotator.getByRole("heading", { name: "登录工作区" }).waitFor();
      const cookie = oldCookies.find(
        (item) => item.name === "annotation_session",
      );
      assert(cookie);
      const oldResponse = await annotator.request.get("/api/auth/me", {
        headers: { Cookie: `${cookie.name}=${cookie.value}` },
      });
      assert.equal(oldResponse.status(), 401);
      await annotator.getByLabel("账号", { exact: true }).fill("b1");
      await annotator.getByLabel("密码", { exact: true }).fill(password);
      await annotator.getByRole("button", { name: "进入工作区" }).click();
      await annotator
        .getByRole("heading", { name: "我的任务", exact: true })
        .waitFor();
      assert.equal(
        await annotator.getByText(title, { exact: true }).count(),
        0,
      );
      const own = await json(annotator, "/api/stats/me");
      assert.equal(own.task_count, 0);
      await annotator.reload();
      await annotator
        .getByRole("heading", { name: "我的任务", exact: true })
        .waitFor();
    });
    assert.deepEqual(errors, [], "Browser runtime errors");
  } catch (error) {
    failed = true;
    for (let index = 0; index < pages.length; index++) {
      await pages[index]
        .screenshot({
          path: path.join(output, `failure-${index}.png`),
          fullPage: true,
        })
        .catch(() => {});
    }
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "scenarios.json"),
      JSON.stringify(scenarios, null, 2),
    );
    for (let index = 0; index < contexts.length; index++) {
      await contexts[index].tracing.stop(
        failed ? { path: path.join(output, `trace-${index}.zip`) } : {},
      );
      await contexts[index].close();
    }
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
