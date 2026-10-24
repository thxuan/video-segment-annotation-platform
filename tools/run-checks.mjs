// Existing function / mocked UI checks only. Never seeds or contacts a business DB.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(root, "src/frontend");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const [mode, ...args] = process.argv.slice(2);
const options = Object.fromEntries(
  args.map((arg) => {
    const match = /^--(page|fragment)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown option: ${arg}`);
    return [match[1], match[2]];
  }),
);
const fragments = [
  "pending-selection",
  "refresh-state",
  "input-feedback",
  "add-focus",
  "row-feedback",
  "frame-shortcuts",
  "save-recovery",
];
if (
  !["functions", "ui", "change", "baseline"].includes(mode) ||
  (["ui", "change"].includes(mode) &&
    ![
      "workspace",
      "statistics",
      "theme",
      "personal",
      "publish",
      "shared",
      "none",
    ].includes(options.page)) ||
  (options.fragment &&
    (options.page !== "workspace" || !fragments.includes(options.fragment))) ||
  (["functions", "baseline"].includes(mode) && args.length)
) {
  console.error(
    "Usage: node tools/run-checks.mjs functions|baseline\n       node tools/run-checks.mjs ui|change --page=workspace|statistics|theme|personal|publish|shared|none [--fragment=frame-shortcuts]",
  );
  process.exit(2);
}

const runId =
  new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`;
const artifactDir = path.join(root, ".cache/checks", runId);
mkdirSync(artifactDir, { recursive: true });
const report = {
  mode,
  scope: mode === "baseline" ? "existing-scripts-only" : options,
  runtime: {
    node: process.version,
    playwright: frontendRequire("playwright/package.json").version,
    browserChannel: process.env.TEST_BROWSER_CHANNEL || "msedge",
  },
  startedAt: new Date().toISOString(),
  steps: [],
  coverage: { realApi: "not-run", postgresql: "not-run", realE2E: "not-run" },
};
let server;
let child;
// Inherited fragment / URL settings must not silently reduce the requested coverage.
const env = { ...process.env };
delete env.EDITOR_FRAGMENT;
delete env.FRONTEND_TEST_URL;
delete env.RUN_DATE_DB_TESTS;
delete env.RUN_AUTOMATION_DB_TESTS;

async function stopChild(target) {
  if (!target || target.exitCode !== null || target.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const kill = spawn("taskkill", ["/PID", String(target.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      kill.once("error", resolve);
      kill.once("close", resolve);
    });
  } else target.kill("SIGTERM");
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    void stopChild(child);
  });
}

async function runStep(
  name,
  executable,
  commandArgs,
  extraEnv = {},
  cwd = root,
) {
  console.log(`\n[check] ${name}`);
  const startedAt = Date.now();
  const step = { name, status: "running" };
  report.steps.push(step);
  const log = [];
  let deadline;
  try {
    if (interrupted) throw new Error("Checks interrupted");
    const code = await new Promise((resolve, reject) => {
      child = spawn(executable, commandArgs, {
        cwd,
        env: { ...env, ...extraEnv },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => {
        process.stdout.write(data);
        log.push(data);
      });
      child.stderr.on("data", (data) => {
        process.stderr.write(data);
        log.push(data);
      });
      child.once("error", reject);
      child.once("close", resolve);
      deadline = setTimeout(() => {
        step.timedOut = true;
        void stopChild(child);
        reject(new Error(`${name} exceeded 240 seconds`));
      }, 240000);
    });
    if (code !== 0) throw new Error(`${name} failed (exit ${code})`);
    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    throw error;
  } finally {
    clearTimeout(deadline);
    if (step.status === "failed") await stopChild(child);
    child = undefined;
    step.durationMs = Date.now() - startedAt;
    writeFileSync(path.join(artifactDir, `${name}.log`), Buffer.concat(log));
  }
}

async function functions() {
  const files = readdirSync(path.join(root, "tests/frontend"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `tests/frontend/${name}`);
  await runStep("frontend-functions", process.execPath, ["--test", ...files]);
  const python =
    process.env.TEST_PYTHON ||
    path.join(
      root,
      "src/backend/.venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  if (!existsSync(python) && !process.env.TEST_PYTHON)
    throw new Error(
      "Backend venv missing; prepare it as documented in README, or set TEST_PYTHON.",
    );
  const backendFiles = readdirSync(path.join(root, "tests/backend"))
    .filter(
      (name) => name.startsWith("test_") && name.endsWith("_fragments.py"),
    )
    .sort()
    .map((name) => `tests/backend/${name}`);
  await runStep(
    "backend-functions",
    python,
    [
      "-m",
      "pytest",
      ...backendFiles,
      `--basetemp=${path.join(artifactDir, "pytest-tmp")}`,
      "-o",
      `cache_dir=${path.join(artifactDir, "pytest-cache")}`,
    ],
    {
      APP_DATABASE_URL:
        "postgresql+psycopg://function_tests:function_tests@127.0.0.1:1/function_tests",
    },
  );
}

async function ui(pages) {
  if (!pages.length) {
    report.steps.push({
      name: "ui",
      status: "not-run",
      reason: "Explicit --page=none; no UI coverage claimed",
    });
    console.log(
      "[check] UI NOT RUN (--page=none): record the missing interaction coverage in the delivery.",
    );
    return;
  }
  if (
    (pages.includes("workspace") ||
      pages.includes("theme") ||
      pages.includes("personal")) &&
    !existsSync(path.join(root, "storage/videos/pusht-demo.mp4"))
  ) {
    throw new Error(
      "Missing storage/videos/pusht-demo.mp4; prepare demo assets as documented in README.",
    );
  }
  // A separate Vite instance avoids changing the developer's running application.
  const { createServer } = await import(
    pathToFileURL(frontendRequire.resolve("vite")).href
  );
  server = await createServer({
    root: frontend,
    configFile: path.join(frontend, "vite.config.ts"),
    plugins: [
      {
        name: "mock-checks-no-backend",
        configureServer(testServer) {
          testServer.middlewares.use((req, res, next) => {
            if (req.url === "/api" || req.url?.startsWith("/api/")) {
              res.statusCode = 503;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  detail: "Test server: real API forwarding is disabled",
                }),
              );
            } else next();
          });
        },
      },
    ],
    cacheDir: path.join(root, ".cache/ui-vite"),
    server: {
      host: "127.0.0.1",
      port: 5183,
      strictPort: true,
      open: false,
      hmr: false,
      watch: { ignored: ["**/.cache/**"] },
    },
  });
  await server.listen();
  for (const page of pages) {
    const selections =
      page === "workspace"
        ? options.fragment
          ? [options.fragment]
          : fragments
        : [""];
    for (const fragment of selections) {
      const name = `${page}${fragment ? `-${fragment}` : ""}`;
      await runStep(
        name,
        process.execPath,
        [
          `tests/frontend/${page === "workspace" ? "editor" : page}-fragments.cjs`,
        ],
        {
          FRONTEND_TEST_URL: "http://127.0.0.1:5183",
          EDITOR_FRAGMENT: fragment,
          TEST_ARTIFACT_DIR: path.join(artifactDir, name),
        },
      );
    }
  }
}

try {
  if (["change", "baseline"].includes(mode)) {
    // build already includes typecheck; do not execute the same typecheck twice.
    await runStep(
      "typecheck",
      process.execPath,
      [
        path.join(
          path.dirname(frontendRequire.resolve("typescript/package.json")),
          "bin/tsc",
        ),
        "--noEmit",
      ],
      {},
      frontend,
    );
    await runStep(
      "build",
      process.execPath,
      [
        path.join(
          path.dirname(frontendRequire.resolve("vite/package.json")),
          "bin/vite.js",
        ),
        "build",
      ],
      {},
      frontend,
    );
  }
  if (mode !== "ui") await functions();
  if (mode !== "functions") {
    const pages =
      mode === "baseline" || options.page === "shared"
        ? ["workspace", "statistics", "theme", "personal", "publish"]
        : options.page === "none"
          ? []
          : [options.page];
    await ui(pages);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`\nCheck report: ${artifactDir}`);
}
