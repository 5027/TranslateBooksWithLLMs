from src.api.handlers import (
    calculate_rate_limit_backoff_seconds,
    next_rate_limit_backoff_attempt,
)


def test_rate_limit_backoff_uses_exponential_steps():
    assert calculate_rate_limit_backoff_seconds(None, 1, base_delay=60, max_delay=900) == 60
    assert calculate_rate_limit_backoff_seconds(None, 2, base_delay=60, max_delay=900) == 120
    assert calculate_rate_limit_backoff_seconds(None, 3, base_delay=60, max_delay=900) == 240


def test_rate_limit_backoff_respects_retry_after_floor():
    assert calculate_rate_limit_backoff_seconds(300, 1, base_delay=60, max_delay=900) == 300


def test_rate_limit_backoff_caps_stepped_delay():
    assert calculate_rate_limit_backoff_seconds(None, 9, base_delay=60, max_delay=900) == 900


def test_next_backoff_attempt_resets_when_checkpoint_advances():
    config = {
        "_auto_resume_last_index": 5,
        "_rate_limit_backoff_attempt": 3,
    }

    assert next_rate_limit_backoff_attempt(config, 5) == 4
    assert next_rate_limit_backoff_attempt(config, 6) == 1
