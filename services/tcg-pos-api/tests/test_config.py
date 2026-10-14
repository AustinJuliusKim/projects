"""Connection settings every psycopg.connect uses — no database needed."""

from tcg_pos_api import config


def test_connect_kwargs_are_pooler_safe(monkeypatch):
    monkeypatch.delenv("DB_CONNECT_TIMEOUT", raising=False)
    kwargs = config.connect_kwargs()
    assert kwargs["prepare_threshold"] is None
    # Must stay below the Lambda timeout (template.yaml: 10 s).
    assert 0 < kwargs["connect_timeout"] < 10
    monkeypatch.setenv("DB_CONNECT_TIMEOUT", "3")
    assert config.connect_kwargs()["connect_timeout"] == 3
