"""Own the disposable test services, enforce deadlines, and persist a scoped report."""
import argparse
from datetime import datetime, timezone
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from xml.etree import ElementTree

from automation_environment import ROOT, CONFIG, clean_uploads, configure, prepare

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["integration", "e2e", "release", "compose"])
parser.add_argument("--build-timeout", type=int, default=1200,
                    help="Maximum seconds per image build in compose mode (60-3600, default 1200)")
args = parser.parse_args()
if not 60 <= args.build_timeout <= 3600:
    parser.error("--build-timeout must be between 60 and 3600 seconds")
run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S") + f"-{os.getpid()}"
artifacts = ROOT / ".cache/automation" / run_id
artifacts.mkdir(parents=True)
report = {"mode": args.mode, "status": "running", "steps": [],
          "coverage": {"functions_and_mock_ui": "not-run", "postgresql_api_and_dates": "not-run",
                       "real_browser": "not-run", "docker_application": "not-run"},
          "started_at": datetime.now(timezone.utc).isoformat()}
processes = []
log_files = []
compose = ["docker", "--config", str(ROOT / ".cache/docker"), "compose", "--env-file", str(CONFIG),
           "-f", str(ROOT / "compose.automation-tests.yaml"), "--profile", "application"]
lock_path = ROOT / ".cache/automation.lock"
owns_lock = False
owns_services = False


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=15)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def launch(name, command, cwd=ROOT):
    output = (artifacts / f"{name}.log").open("wb")
    log_files.append(output)
    process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                               env=os.environ.copy(), start_new_session=os.name != "nt")
    processes.append(process)
    return process


def step(name, command, timeout=240, cwd=ROOT):
    print(f"[automation] {name}", flush=True)
    entry = {"name": name, "status": "running"}
    report["steps"].append(entry)
    started = time.monotonic()
    process = launch(name, command, cwd)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise RuntimeError(f"{name} failed (exit {code}); inspect its artifact log")
        entry["status"] = "passed"
    except subprocess.TimeoutExpired:
        entry["status"] = "timed-out"
        stop_process(process)
        raise RuntimeError(f"{name} exceeded {timeout}s") from None
    except BaseException:
        entry["status"] = "failed"
        raise
    finally:
        entry["duration_seconds"] = round(time.monotonic() - started, 2)


def ready(url, process=None):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("Isolated server exited before becoming ready; inspect its log")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Isolated server readiness timed out")


def interrupt(signum, frame):
    raise KeyboardInterrupt


def require_free_port(port):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))


signal.signal(signal.SIGTERM, interrupt)
try:
    with lock_path.open("x", encoding="utf-8") as lock:
        lock.write(str(os.getpid()))
    owns_lock = True
    prepare()
    configure()
    os.environ["RUN_AUTOMATION_DB_TESTS"] = "1"
    os.environ.pop("RUN_DATE_DB_TESTS", None)
    os.environ["TEST_ARTIFACT_DIR"] = str(artifacts / "browser")
    os.environ["TEST_PYTHON"] = sys.executable
    report["python"] = sys.version.split()[0]
    report["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
    # This project owns only its fixed automation compose name and ports.
    step("discard-interrupted-test-containers", [*compose, "down", "--remove-orphans"], timeout=60)
    owns_services = True
    step("start-disposable-postgresql", [*compose, "up", "-d", "--pull", "never", "--wait", "db"], timeout=100)
    step("fresh-migration", [sys.executable, "tools/automation_environment.py", "migrate"])
    if args.mode == "release":
        report["coverage"]["functions_and_mock_ui"] = "running"
        step("existing-baseline", ["node", "tools/run-checks.mjs", "baseline"], timeout=600)
        report["coverage"]["functions_and_mock_ui"] = "passed"
    if args.mode in ("integration", "release"):
        report["coverage"]["postgresql_api_and_dates"] = "running"
        step("postgresql-api-and-date-tests", [sys.executable, "-m", "pytest", "tests/backend", "tests/integration",
             "-v", "--tb=short", f"--basetemp={artifacts / 'pytest-tmp'}",
             "-o", f"cache_dir={artifacts / 'pytest-cache'}", f"--junitxml={artifacts / 'pytest.xml'}"], timeout=300)
        suites = ElementTree.parse(artifacts / "pytest.xml").getroot().iter("testsuite")
        counts = {key: 0 for key in ("tests", "skipped", "errors", "failures")}
        for suite in suites:
            for key in counts:
                counts[key] += int(suite.get(key, "0"))
        report["pytest"] = counts
        if not counts["tests"] or counts["skipped"]:
            raise RuntimeError("Release API tests must execute without skipped cases")
        report["coverage"]["postgresql_api_and_dates"] = "passed"
    if args.mode != "integration":
        step("repeat-real-demo-seed", [sys.executable, "tools/automation_environment.py", "seed"])
        if args.mode == "compose":
            require_free_port(5801)
            require_free_port(5880)
            report["coverage"]["docker_application"] = "running"
            report["build_timeout_seconds_per_image"] = args.build_timeout
            step("build-linux-api-image", [*compose, "build", "api"], timeout=args.build_timeout)
            step("build-linux-web-image", [*compose, "build", "web"], timeout=args.build_timeout)
            step("start-linux-application", [*compose, "up", "--no-build", "-d", "--wait", "--wait-timeout", "90"], timeout=120)
            base_url = "http://127.0.0.1:5880"
        else:
            require_free_port(5801)
            require_free_port(5184)
            if args.mode != "release":
                step("production-build", ["node", "node_modules/typescript/bin/tsc", "--noEmit"], cwd=ROOT / "src/frontend")
                step("vite-build", ["node", "node_modules/vite/bin/vite.js", "build"], cwd=ROOT / "src/frontend")
            api = launch("isolated-api", [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "5801"],
                         cwd=ROOT / "src/backend")
            ready("http://127.0.0.1:5801/api/ready", api)
            web = launch("production-preview", ["node", "tools/automation-preview.mjs"])
            base_url = "http://127.0.0.1:5184"
            ready(base_url, web)
        ready(base_url + "/api/ready")
        os.environ["AUTOMATION_BASE_URL"] = base_url
        report["coverage"]["real_browser"] = "running"
        step("real-browser-business-flow", ["node", "tests/e2e/business-flow.cjs"], timeout=240)
        report["coverage"]["real_browser"] = "passed"
        if args.mode == "compose":
            report["coverage"]["docker_application"] = "passed"
    report["status"] = "passed"
except BaseException as error:
    report["status"] = "failed"
    report["error"] = "Interrupted" if isinstance(error, KeyboardInterrupt) else str(error)
    for key, value in report["coverage"].items():
        if value == "running":
            report["coverage"][key] = "failed"
    print(f"[automation] {report['error']}", file=sys.stderr)
finally:
    for process in reversed(processes):
        stop_process(process)
    if owns_services:
        try:
            step("stop-disposable-services", [*compose, "down", "--remove-orphans"], timeout=60)
        except Exception:
            report["status"] = "failed"
            report["cleanup_error"] = "Could not stop disposable services; inspect stop log"
    for output in log_files:
        output.close()
    if owns_lock:
        try:
            clean_uploads()
            lock_path.unlink(missing_ok=True)
        except OSError:
            report["status"] = "failed"
            report["cleanup_error"] = "Could not clean owned upload artifacts/lock; inspect local file access"
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    (artifacts / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Automation report: {artifacts}", flush=True)
sys.exit(0 if report["status"] == "passed" else 1)
