// Real App and browser, with every API mocked. No acceptance data is touched.
const { createBrowserSession } = require("./browser-session.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const baseUrl = process.env.FRONTEND_TEST_URL || "http://127.0.0.1:5173";

(async () => {
  const session = await createBrowserSession("publish", {
    width: 1440,
    height: 1000,
  });
  const { page, artifactDir } = session;
  const scenarios = [];
  const errors = [];
  const serverErrors = [];
  const gates = new Set();
  let posts = [];
  let published = [];
  let attempts = new Map();
  let loggedIn = true;
  let acceptDialogs = true;
  let dialogMessages = [];
  let activeRequests = 0;
  let maximumActive = 0;
  let postHandler;
  const identity = {
    user: {
      id: "publish-admin",
      username: "admin",
      display_name: "管理员",
      role: "admin",
      tenant_id: null,
      tenant_name: null,
    },
    csrf_token: "mock-publish-csrf",
  };
  const file = (name, buffer = Buffer.from(`mock-video:${name}`)) => ({
    name,
    mimeType: "video/mp4",
    buffer,
  });
  const rows = page.locator(".publish-file-list > li");
  const publishButton = page.getByRole("button", {
    name: "发布任务",
    exact: true,
  });
  const tenantInput = page.getByRole("combobox", { name: /^所属租户/ });
  const statusFilters = page.getByRole("group", { name: "按发布状态筛选" });
  const titleButton = (n) =>
    page.getByRole("button", { name: `编辑任务 ${n} 标题`, exact: true });
  const titleInput = (n) => page.getByLabel(`任务 ${n} 标题`, { exact: true });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    dialogMessages.push(dialog.message());
    if (acceptDialogs || dialog.type() === "beforeunload")
      await dialog.accept();
    else await dialog.dismiss();
  });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "annotation-page-v1:publish-admin",
      JSON.stringify({ view: "publish", selectedId: null }),
    );
    localStorage.setItem("video-annotation-theme", "dark");
  });

  function task(record) {
    return {
      id: `published-${published.length + 1}`,
      title: record.title,
      tenant_id: record.tenant,
      tenant_name: record.tenant === "tenant-a" ? "租户 A" : "租户 B",
      status: "available",
      duration_ms: 2000,
      assignee_id: null,
      assignee_name: null,
      created_at: "2026-10-24T01:00:00Z",
      submitted_at: null,
      revision: 0,
      segments: [],
      effective_ms: 0,
    };
  }
  async function success(route, record) {
    const created = task(record);
    published.push(created);
    await route.fulfill({ status: 201, json: created });
  }
  await page.route("**/api/**", async (route) => {
    try {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === "/api/auth/me")
        return await route.fulfill({
          status: loggedIn ? 200 : 401,
          json: loggedIn ? identity : { detail: "登录已过期" },
        });
      if (url.pathname === "/api/auth/logout") {
        loggedIn = false;
        return await route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/tenants")
        return await route.fulfill({
          json: [
            { id: "tenant-a", name: "租户 A" },
            { id: "tenant-b", name: "租户 B" },
          ],
        });
      if (url.pathname === "/api/tasks" && req.method() === "POST") {
        const record = {
          title: url.searchParams.get("title"),
          tenant: url.searchParams.get("tenant_id"),
          body: req.postDataBuffer(),
        };
        assert.equal(req.headers()["x-csrf-token"], identity.csrf_token);
        assert.equal(req.headers()["content-type"], "video/mp4");
        assert(record.body?.length, "Each upload must send actual file bytes");
        assert(["tenant-a", "tenant-b"].includes(record.tenant));
        posts.push(record);
        const attempt = (attempts.get(record.title) || 0) + 1;
        attempts.set(record.title, attempt);
        activeRequests++;
        maximumActive = Math.max(maximumActive, activeRequests);
        try {
          await postHandler(route, record, attempt);
        } finally {
          activeRequests--;
        }
        return;
      }
      if (url.pathname === "/api/tasks")
        return await route.fulfill({
          json: {
            items: published,
            total: published.length,
            page: 1,
            page_size: 20,
          },
        });
      const detail = /^\/api\/tasks\/(published-\d+)$/.exec(url.pathname);
      if (detail)
        return await route.fulfill({
          json: published.find((item) => item.id === detail[1]),
        });
      if (/^\/api\/tasks\/published-\d+\/frames$/.test(url.pathname))
        return await route.fulfill({
          json: { frame_times_ms: [0, 100, 200, 1000] },
        });
      if (/^\/api\/tasks\/published-\d+\/video$/.test(url.pathname))
        return await route.fulfill({
          status: 404,
          body: "No real media in mocked publish checks",
        });
      return await route.fallback();
    } catch (error) {
      serverErrors.push(String(error.stack || error));
      await route.abort().catch(() => {});
    }
  });

  async function reset() {
    for (const release of gates) release();
    gates.clear();
    posts = [];
    published = [];
    attempts = new Map();
    activeRequests = 0;
    maximumActive = 0;
    loggedIn = true;
    acceptDialogs = true;
    dialogMessages = [];
    postHandler = success;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(baseUrl);
    await page
      .getByRole("heading", { name: "发布任务", exact: true })
      .waitFor();
    await tenantInput
      .locator('option[value="tenant-a"]')
      .waitFor({ state: "attached" });
  }
  async function choose(files) {
    await page.locator('input[type="file"]').setInputFiles(files);
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".publish-file-list > li").length === count,
      files.length,
    );
  }
  async function filter(label) {
    await statusFilters
      .getByRole("button", { name: new RegExp(`^${label}\\s*\\d+$`) })
      .click();
  }
  async function idle(succeeded, count) {
    await page
      .locator(".publish-action-content > span")
      .filter({ hasText: new RegExp(`^已发布 ${succeeded} / ${count}$`) })
      .waitFor();
  }
  async function scenario(name, run) {
    const result = { name, status: "running" };
    scenarios.push(result);
    const started = Date.now();
    try {
      await reset();
      await run();
      assert.deepEqual(errors, [], "Browser runtime errors");
      assert.deepEqual(serverErrors, [], "Mock assertions");
      result.status = "passed";
      console.log(`PASS: ${name}`);
    } catch (error) {
      result.status = "failed";
      throw error;
    } finally {
      result.durationMs = Date.now() - started;
    }
  }
  async function screenshot(name) {
    await page.screenshot({
      path: path.join(artifactDir, name),
      fullPage: true,
    });
  }

  try {
    await scenario(
      "50/150 videos keep page height bounded, list scrolls independently, four theme/viewport layouts",
      async () => {
        await choose(
          Array.from({ length: 50 }, (_, i) =>
            file(
              `示教-${String(i).padStart(3, "0")}-${"long-name-".repeat(5)}.mp4`,
            ),
          ),
        );
        const height50 = await page.evaluate(
          () => document.documentElement.scrollHeight,
        );
        await choose(
          Array.from({ length: 150 }, (_, i) =>
            file(
              `示教-${String(i).padStart(3, "0")}-${"long-name-".repeat(5)}.mp4`,
            ),
          ),
        );
        assert(
          Math.abs(
            (await page.evaluate(() => document.documentElement.scrollHeight)) -
              height50,
          ) <= 2,
        );
        for (const viewport of [
          { width: 1440, height: 1000 },
          { width: 390, height: 900 },
        ]) {
          await page.setViewportSize(viewport);
          for (const theme of ["dark", "light"]) {
            await page
              .getByRole("button", {
                name: theme === "dark" ? "深色模式" : "浅色模式",
                exact: true,
              })
              .click();
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            const before = await page.evaluate(() => {
              const list = document.querySelector(".publish-list-scroll");
              const summary = document
                .querySelector(".publish-queue-toolbar")
                .getBoundingClientRect();
              const actions = document
                .querySelector(".publish-action-bar")
                .getBoundingClientRect();
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                listHeight: list.clientHeight,
                listScroll: list.scrollHeight,
                xOverflow: list.scrollWidth > list.clientWidth,
                summaryY: summary.y,
                actionY: actions.y,
                actionBottom: actions.bottom,
                windowY: scrollY,
              };
            });
            assert.equal(before.overflow, false);
            assert.equal(before.xOverflow, false);
            assert(before.listScroll > before.listHeight * 10);
            assert(
              before.listHeight <=
                Math.min(
                  viewport.height * (viewport.width < 640 ? 0.42 : 0.5),
                  480,
                ) +
                  2,
            );
            assert(
              before.actionY >= 0 && before.actionBottom <= viewport.height + 2,
              "Actions stay in viewport",
            );
            await page
              .locator(".publish-list-scroll")
              .evaluate((list) => (list.scrollTop = list.scrollHeight));
            const after = await page.evaluate(() => ({
              summaryY: document
                .querySelector(".publish-queue-toolbar")
                .getBoundingClientRect().y,
              actionY: document
                .querySelector(".publish-action-bar")
                .getBoundingClientRect().y,
              windowY: scrollY,
            }));
            assert.deepEqual(after, {
              summaryY: before.summaryY,
              actionY: before.actionY,
              windowY: before.windowY,
            });
            const lastRow = await rows.last().boundingBox();
            const actionBar = await page
              .locator(".publish-action-bar")
              .boundingBox();
            assert(
              lastRow.y + lastRow.height <= actionBar.y + 1,
              "The last video must be fully visible above the action bar after scrolling to the end",
            );
            const bounds = await page
              .locator(".publish-list-scroll")
              .boundingBox();
            await page.mouse.move(
              bounds.x + 60,
              Math.min(bounds.y + 35, viewport.height - 110),
            );
            await page.mouse.wheel(0, 600);
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            assert.equal(
              await page.evaluate(() => scrollY),
              before.windowY,
              "List boundary must not scroll the page",
            );
            await screenshot(
              `publish-${viewport.width < 640 ? "mobile" : "desktop"}-${theme}.png`,
            );
          }
        }
        assert.equal(posts.length, 0);
      },
    );

    await scenario(
      "title Enter/blur/Escape, whitespace rejection and original file payloads",
      async () => {
        const files = [file("alpha.mp4"), file("beta.mp4")];
        await choose(files);
        await tenantInput.selectOption("tenant-b");
        assert.equal(await titleButton(1).innerText(), "alpha");
        await titleButton(1).click();
        await titleInput(1).fill("任务 A");
        await titleInput(1).press("Enter");
        await titleButton(1).click();
        await titleInput(1).fill("应被取消");
        await titleInput(1).press("Escape");
        assert.equal(await titleButton(1).innerText(), "任务 A");
        await titleButton(2).click();
        await titleInput(2).fill("   ");
        await titleInput(2).press("Enter");
        await publishButton.click();
        await page
          .getByText("每个视频都需要 1–200 个字符的任务标题。", { exact: true })
          .waitFor();
        assert.equal(posts.length, 0);
        await titleInput(2).fill("任务 B");
        await tenantInput.focus();
        assert.equal(await titleButton(2).innerText(), "任务 B");
        await publishButton.click();
        await idle(2, 2);
        assert.deepEqual(
          posts.map((item) => [item.title, item.tenant]),
          [
            ["任务 A", "tenant-b"],
            ["任务 B", "tenant-b"],
          ],
        );
        assert(posts[0].body.equals(files[0].buffer));
        assert(posts[1].body.equals(files[1].buffer));
        assert.equal(await rows.locator("input").count(), 0);
        assert.equal(
          await page.getByText("任务已创建", { exact: true }).count(),
          0,
        );
      },
    );

    await scenario(
      "sequential upload, duplicate-click guard, busy locks and display-only filtering",
      async () => {
        await choose([
          file("first.mp4"),
          file("second.mp4"),
          file("third.mp4"),
        ]);
        await tenantInput.selectOption("tenant-a");
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        gates.add(release);
        postHandler = async (route, record) => {
          if (record.title === "first") await gate;
          await success(route, record);
        };
        await publishButton.evaluate((button) => {
          button.click();
          button.click();
        });
        await page.locator(".publish-item-uploading").waitFor();
        assert.equal(posts.length, 1);
        assert.equal(await tenantInput.isDisabled(), true);
        assert.equal(
          await page.locator('input[type="file"]').isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "任务管理", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await page.locator(".publish-item-uploading progress").count(),
          1,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "新建一批", exact: true })
            .isDisabled(),
          true,
        );
        await filter("失败");
        await page.getByText("当前筛选下没有视频。", { exact: true }).waitFor();
        assert.equal(posts.length, 1);
        release();
        gates.delete(release);
        await idle(3, 3);
        assert.deepEqual(
          posts.map((item) => item.title),
          ["first", "second", "third"],
        );
        assert.equal(maximumActive, 1);
        await filter("已发布");
        assert.equal(await rows.count(), 3);
        assert.equal(
          await rows
            .getByRole("button", { name: "查看任务", exact: true })
            .count(),
          3,
        );
        assert.equal(await publishButton.isDisabled(), true);
        await rows
          .getByRole("button", { name: "查看任务", exact: true })
          .first()
          .click();
        await page
          .getByRole("heading", { name: "first", exact: true })
          .waitFor();
        assert.equal(
          dialogMessages.length,
          0,
          "Completed uploads do not trigger an unsaved warning",
        );
      },
    );

    await scenario(
      "partial failures keep successes, details collapse and retries send only failed files",
      async () => {
        await choose([file("good.mp4"), file("bad.mp4"), file("last.mp4")]);
        await tenantInput.selectOption("tenant-a");
        postHandler = async (route, record, attempt) =>
          record.title === "bad" && attempt === 1
            ? route.fulfill({ status: 422, json: { detail: "模拟编码不支持" } })
            : success(route, record);
        await publishButton.click();
        await idle(2, 3);
        assert.equal(await tenantInput.isDisabled(), true);
        await filter("失败");
        assert.equal(await rows.count(), 1);
        assert.equal(await rows.locator("details").getAttribute("open"), null);
        await rows.locator("summary").click();
        await page.getByText("模拟编码不支持", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "重试失败项（1）", exact: true })
          .click();
        await idle(3, 3);
        assert.deepEqual(
          posts.map((item) => item.title),
          ["good", "bad", "last", "bad"],
        );
        assert(posts.every((item) => item.tenant === "tenant-a"));
        await filter("已发布");
        assert.equal(await rows.count(), 3);
        await page
          .getByRole("button", { name: "新建一批", exact: true })
          .click();
        assert.equal(await rows.count(), 0);
        assert.equal(await tenantInput.isEnabled(), true);
        await tenantInput.selectOption("tenant-b");
        await choose([file("next.mp4")]);
        await publishButton.click();
        await idle(1, 1);
        assert.equal(posts.at(-1).tenant, "tenant-b");
      },
    );

    await scenario(
      "empty/non-MP4 files do not send requests; single retry and removing the last failure reset selection",
      async () => {
        await choose([
          file("empty.mp4", Buffer.alloc(0)),
          file("wrong.txt"),
          file("valid.mp4"),
        ]);
        await tenantInput.selectOption("tenant-a");
        await publishButton.click();
        await idle(1, 3);
        assert.deepEqual(
          posts.map((item) => item.title),
          ["valid"],
        );
        assert.equal(await page.locator(".publish-item-failed").count(), 2);
        await page
          .locator(".publish-item-failed")
          .first()
          .getByRole("button", { name: "重试", exact: true })
          .click();
        await idle(1, 3);
        assert.equal(posts.length, 1);
        await page
          .getByRole("button", { name: "移除 empty.mp4", exact: true })
          .click();
        await page
          .getByRole("button", { name: "移除 wrong.txt", exact: true })
          .click();
        await page
          .getByRole("button", { name: "新建一批", exact: true })
          .click();
        await choose([file("only-empty.mp4", Buffer.alloc(0))]);
        await publishButton.click();
        await idle(0, 1);
        await page
          .getByRole("button", { name: "移除 only-empty.mp4", exact: true })
          .click();
        assert.equal(
          await page.locator('input[type="file"]').isEnabled(),
          true,
        );
        await choose([file("only-empty.mp4")]);
        await publishButton.click();
        await idle(1, 1);
        assert.equal(posts.at(-1).title, "only-empty");
      },
    );

    for (const kind of ["network", "500", "malformed-201"]) {
      await scenario(
        `${kind}: uncertain results pause, remaining queue continues separately, retry needs confirmation`,
        async () => {
          await choose([file("uncertain.mp4"), file("waiting.mp4")]);
          await tenantInput.selectOption("tenant-a");
          postHandler = async (route, record, attempt) => {
            if (record.title === "uncertain" && attempt === 1) {
              if (kind === "network") return route.abort("failed");
              if (kind === "500")
                return route.fulfill({
                  status: 500,
                  json: { detail: "模拟异常" },
                });
              published.push(task(record));
              return route.fulfill({
                status: 201,
                contentType: "application/json",
                body: "{truncated",
              });
            }
            return success(route, record);
          };
          await publishButton.click();
          await idle(0, 2);
          assert.equal(posts.length, 1);
          assert.equal(
            await page.locator(".publish-item-uncertain").count(),
            1,
          );
          assert.equal(await page.locator(".publish-item-queued").count(), 1);
          assert.equal(
            await page
              .locator(".publish-item-uncertain details")
              .getAttribute("open"),
            null,
          );
          await publishButton.click();
          await idle(1, 2);
          assert.deepEqual(
            posts.map((item) => item.title),
            ["uncertain", "waiting"],
          );
          acceptDialogs = false;
          await page
            .getByRole("button", { name: "核对后重试", exact: true })
            .click();
          assert.equal(posts.length, 2);
          assert.match(dialogMessages.at(-1), /重复任务/);
          if (kind !== "malformed-201") {
            acceptDialogs = true;
            await page
              .getByRole("button", { name: "核对后重试", exact: true })
              .click();
            await idle(2, 2);
            assert.deepEqual(
              posts.map((item) => item.title),
              ["uncertain", "waiting", "uncertain"],
            );
            assert(posts[0].body.equals(posts[2].body));
          } else
            assert.equal(
              published.length,
              2,
              "Lost acknowledgement must not automatically create a duplicate task",
            );
        },
      );
    }

    for (const status of [401, 403]) {
      await scenario(
        `${status}: stop the queue and handle authentication consistently`,
        async () => {
          await choose([file("denied.mp4"), file("never-sent.mp4")]);
          await tenantInput.selectOption("tenant-a");
          postHandler = async (route) => {
            if (status === 401) loggedIn = false;
            await route.fulfill({ status, json: { detail: "模拟认证失败" } });
          };
          await publishButton.click();
          if (status === 401)
            await page
              .getByRole("heading", { name: "登录工作区", exact: true })
              .waitFor();
          else {
            await idle(0, 2);
            assert.equal(await page.locator(".publish-item-queued").count(), 1);
          }
          assert.equal(posts.length, 1);
        },
      );
    }

    await scenario(
      "unsaved navigation and reset can be cancelled; reopening starts with an empty queue",
      async () => {
        await choose([file("unsaved.mp4")]);
        acceptDialogs = false;
        await page
          .getByRole("button", { name: "任务管理", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "发布任务", exact: true })
          .waitFor();
        assert.equal(await rows.count(), 1);
        await page
          .getByRole("button", { name: "新建一批", exact: true })
          .click();
        assert.equal(await rows.count(), 1);
        acceptDialogs = true;
        await page
          .getByRole("button", { name: "任务管理", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "所有任务", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "发布任务", exact: true })
          .click();
        assert.equal(await rows.count(), 0);
        assert.equal(posts.length, 0);
      },
    );
  } catch (error) {
    await session.captureFailure(error);
    throw error;
  } finally {
    for (const release of gates) release();
    fs.writeFileSync(
      path.join(artifactDir, "scenarios.json"),
      JSON.stringify(scenarios, null, 2),
    );
    await session.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
