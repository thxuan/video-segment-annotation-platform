// Shared setup for mocked browser checks. No API request may reach a real server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const frontendRequire = createRequire(
  path.resolve(__dirname, "../../src/frontend/package.json"),
);
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH
  ? require(process.env.PLAYWRIGHT_MODULE_PATH)
  : frontendRequire("playwright");

async function createBrowserSession(name, viewport, { hasTouch = false } = {}) {
  const artifactDir =
    process.env.TEST_ARTIFACT_DIR ||
    path.resolve(__dirname, "../../.cache/checks", `${name}-${Date.now()}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  fs.writeFileSync(
    path.join(artifactDir, "browser.json"),
    JSON.stringify(
      {
        channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
        version: browser.version(),
        viewport,
        hasTouch,
      },
      null,
      2,
    ) + "\n",
  );
  const context = await browser.newContext({ viewport, hasTouch });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const blocked = [];
  // Later, more specific mocks override this fallback. Never forward an unhandled API.
  await context.route("**/api/**", async (route) => {
    blocked.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  let failed = false;
  return {
    artifactDir,
    browser,
    context,
    page,
    async captureFailure(error) {
      failed = true;
      fs.writeFileSync(
        path.join(artifactDir, "failure.txt"),
        String(error.stack || error),
      );
      await page
        .screenshot({
          path: path.join(artifactDir, "failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      console.error(`Browser failure evidence: ${artifactDir}`);
    },
    async close() {
      if (blocked.length && !failed) {
        await this.captureFailure(
          new Error(`Unmocked API requests: ${blocked.join(", ")}`),
        );
      }
      try {
        await context.tracing.stop(
          failed ? { path: path.join(artifactDir, "trace.zip") } : {},
        );
      } finally {
        await browser.close();
      }
      assert.deepEqual(
        blocked,
        [],
        "All API requests must have explicit mocks",
      );
    },
  };
}

module.exports = { createBrowserSession };
