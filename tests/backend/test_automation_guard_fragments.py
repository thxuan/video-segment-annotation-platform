"""A changed test config must never redirect destructive test setup to another DB."""
import pytest

from tools import automation_environment


@pytest.mark.parametrize("url", [
    "postgresql+psycopg://annotation_automation_tests:unused@127.0.0.1:55433/annotation_automation_tests",
    "postgresql+psycopg://annotation_automation_tests:unused@127.0.0.1:55435/annotation",
    "postgresql+psycopg://admin:unused@127.0.0.1:55435/annotation_automation_tests",
    "postgresql+psycopg://annotation_automation_tests:unused@remote.example:55435/annotation_automation_tests",
    "sqlite:///acceptance.db",
    "postgresql+psycopg://annotation_automation_tests:unused@127.0.0.1:55435/annotation_automation_tests?host=remote.example",
])
def test_test_environment_rejects_other_ports_databases_users_hosts_and_drivers(monkeypatch, url):
    monkeypatch.setattr(automation_environment, "dotenv_values", lambda path: {"APP_AUTOMATION_DATABASE_URL": url})
    with pytest.raises(RuntimeError, match="Refusing a database"):
        automation_environment.guarded_url()
