"""Prepare isolated local test credentials without reading the acceptance .env."""
from pathlib import Path
import secrets


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".cache" / "date-tests.env"


def main():
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    if CONFIG.exists():
        print("Existing .cache/date-tests.env preserved.")
        return
    password = secrets.token_hex(24)
    with CONFIG.open("x", encoding="utf-8", newline="\n") as output:
        output.write(
            f"DATE_TEST_PASSWORD={password}\n"
            "APP_DATE_TEST_DATABASE_URL=postgresql+psycopg://"
            f"annotation_date_tests:{password}@127.0.0.1:55434/annotation_date_tests\n"
        )
    print("Created .cache/date-tests.env; isolated PostgreSQL port: 55434.")


if __name__ == "__main__":
    main()
