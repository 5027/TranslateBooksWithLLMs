"""
Unit tests for the /api/glossaries/<gid>/suggest-terms endpoint.

Verifies that provider RateLimitError surfaces as HTTP 429 with a
Retry-After header instead of being swallowed as a generic 500.
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from flask import Flask

# Make the project importable regardless of where pytest is invoked from.
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from src.api.blueprints.glossary_routes import create_glossary_blueprint
from src.core.glossary.store import GlossaryStore
from src.core.llm.exceptions import RateLimitError


@pytest.fixture
def store():
    """Per-test temporary GlossaryStore on an isolated SQLite file."""
    db = os.path.join(
        tempfile.gettempdir(),
        f"glossary_ner_endpoint_{os.getpid()}_{id(object())}.db",
    )
    if os.path.exists(db):
        os.remove(db)
    s = GlossaryStore(db_path=db)
    try:
        yield s
    finally:
        s.close_all()
        try:
            os.remove(db)
        except OSError:
            pass


@pytest.fixture
def client(store):
    """Flask test client with the glossary blueprint mounted on a fresh store."""
    app = Flask(__name__)
    app.register_blueprint(create_glossary_blueprint(store=store))
    with app.test_client() as c:
        yield c


class _RateLimitedProvider:
    """Stand-in LLMProvider whose generate() always raises RateLimitError."""

    def __init__(self, retry_after=None, provider_name="testprov"):
        self._retry_after = retry_after
        self._provider_name = provider_name

    async def generate(self, user_prompt, system_prompt=None, **kwargs):
        raise RateLimitError(
            "rate limit reached",
            retry_after=self._retry_after,
            provider=self._provider_name,
        )


class TestSuggestTermsRateLimit:
    """The endpoint must translate RateLimitError into a 429 response."""

    def _create_glossary(self, store):
        return store.create_glossary(
            name="rl-test",
            source_language="English",
            target_language="French",
        )

    def test_rate_limit_returns_429_with_retry_after_header(self, client, store):
        glossary = self._create_glossary(store)

        provider = _RateLimitedProvider(retry_after=42, provider_name="ollama")
        with patch(
            "src.core.llm.factory.create_llm_provider",
            return_value=provider,
        ):
            response = client.post(
                f"/api/glossaries/{glossary.id}/suggest-terms",
                json={"text": "Some sample source text to analyze."},
            )

        assert response.status_code == 429
        assert response.headers.get("Retry-After") == "42"
        body = response.get_json()
        assert body["provider"] == "ollama"
        assert body["retry_after"] == 42
        assert "rate limit" in body["error"].lower()

    def test_rate_limit_without_retry_after_omits_header(self, client, store):
        glossary = self._create_glossary(store)

        provider = _RateLimitedProvider(retry_after=None, provider_name="openrouter")
        with patch(
            "src.core.llm.factory.create_llm_provider",
            return_value=provider,
        ):
            response = client.post(
                f"/api/glossaries/{glossary.id}/suggest-terms",
                json={"text": "Some sample source text."},
            )

        assert response.status_code == 429
        assert "Retry-After" not in response.headers
        body = response.get_json()
        assert body["provider"] == "openrouter"
        assert body["retry_after"] is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
