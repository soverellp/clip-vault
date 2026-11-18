import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth  # noqa: E402
import common  # noqa: E402
import fakes  # noqa: E402
import store  # noqa: E402
import app as A  # noqa: E402

REAL_VAULTSTORE = store.VaultStore  # before any fixture swaps it for the in-memory fake
READ_TOKEN = "hf_" "FAKE_read_token_0000"
WRITE_TOKEN = "hf_" "FAKE_write_token_1111"
SESSION_SECRET = "s" * 48
SECRETS = [READ_TOKEN, WRITE_TOKEN, SESSION_SECRET]


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for k, v in {"VAULT_READ_TOKEN": READ_TOKEN, "VAULT_WRITE_TOKEN": WRITE_TOKEN, "GOOGLE_CLIENT_ID": fakes.CLIENT_ID,
                 "SESSION_SECRET": SESSION_SECRET, "ALLOWED_EMAILS": "viewer@example.com, friend@example.com",
                 "ADMIN_EMAILS": "root@example.com"}.items():
        monkeypatch.setenv(k, v)
    for k in ("VAULT_DATASET", "SESSIONS_NOT_BEFORE"):
        monkeypatch.delenv(k, raising=False)
    common._hits.clear()
    common._last_prune = 0.0
    A._proxy_logged = True
    state = fakes.FakeState()
    fakes.seed(state, [fakes.clip("c1"), fakes.clip("c2"), fakes.clip("t1", trashed=True)])
    monkeypatch.setattr(store, "VaultStore", fakes.make_store_class(state))
    store.reset()
    monkeypatch.setattr(auth, "verify_google_credential", fakes.fake_verify)
    upstream = []
    monkeypatch.setattr(A, "fetch_upstream", fakes.fake_fetch_factory(state, upstream))
    yield {"state": state, "upstream": upstream}
    store.reset()
