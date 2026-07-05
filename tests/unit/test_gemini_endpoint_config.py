from src.core.llm.providers.gemini import GeminiProvider, _normalize_gemini_base_url
from src.core.llm_client import create_llm_client


def test_gemini_provider_uses_custom_base_url():
    provider = GeminiProvider(
        api_key="test-key",
        model="gemini-2.0-flash",
        api_endpoint="http://proxy.local/v1beta",
    )

    assert provider.models_endpoint == "http://proxy.local/v1beta/models"
    assert provider.api_endpoint == (
        "http://proxy.local/v1beta/models/gemini-2.0-flash:generateContent"
    )


def test_gemini_endpoint_normalizes_full_generate_url_to_base():
    endpoint = (
        "https://example.test/gemini/v1beta/models/"
        "gemini-2.0-flash:generateContent?key=unused"
    )

    assert _normalize_gemini_base_url(endpoint) == "https://example.test/gemini/v1beta"


def test_create_llm_client_passes_gemini_endpoint():
    client = create_llm_client(
        "gemini",
        "test-key",
        "http://proxy.local/v1beta",
        "gemini-2.0-flash",
    )

    provider = client._get_provider()
    assert provider.api_base_url == "http://proxy.local/v1beta"
