import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

_tmp = tempfile.mkdtemp(prefix="jarvis-test-")
os.environ.update({"DATA_DIR": _tmp, "BRAIN": "mock", "COOKIE_SECURE": "0", "STT_PROVIDER": "none",
                   "NODE_TOKEN": "test-node-token-123", "DAILY_BUDGET_USD": "5", "TZ": "Europe/Kyiv",
                   "MAX_PARALLEL_AGENTS": "3", "MARKET_FEED": "0"})
for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "STABILITY_API_KEY"):
    os.environ.pop(k, None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import auth, db  # noqa: E402
from app.main import app, state  # noqa: E402

PASSWORD = "correct-horse-battery"


def wait_for(fn, timeout=8.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    raise AssertionError("умова не виконалась вчасно")


@pytest.fixture(scope="session")
def client():
    with TestClient(app, base_url="http://testserver") as c:
        auth.set_password(PASSWORD)
        r = c.post("/api/login", json={"password": PASSWORD, "code": ""}, headers={"X-Jarvis": "1"})
        assert r.json().get("enroll"), r.text
        secret = r.json()["secret"]
        r = c.post("/api/2fa/enroll", json={"enroll_token": r.json()["enroll_token"], "code": auth.totp_code(secret)},
                   headers={"X-Jarvis": "1"})
        assert r.json().get("ok"), r.text
        c.headers.update({"X-Jarvis": "1"})
        c.totp_secret = secret
        yield c


@pytest.fixture()
def brain():
    b = state["brain"]
    b.script.clear()
    b.delay = 0
    return b


@pytest.fixture(autouse=True)
def _fresh():
    db.set_setting("halted", False)
    db.run("DELETE FROM locks")
    yield
