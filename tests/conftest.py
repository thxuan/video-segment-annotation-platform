"""Give direct pytest invocations fresh local temp directories as well as the runners."""
import os
from pathlib import Path
import time


def pytest_configure(config):
    if config.option.basetemp is None:
        root = Path(__file__).resolve().parents[1]
        directory = root / ".cache/pytest"
        directory.mkdir(parents=True, exist_ok=True)
        config.option.basetemp = str(directory / f"{time.time_ns()}-{os.getpid()}")
