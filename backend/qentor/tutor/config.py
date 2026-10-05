"""Environment configuration for the optional LLM layer.

Per CLAUDE.md: "Never put API keys or IBM tokens in the frontend, in git, or
in logs. Use a git-ignored .env." Nothing here reads a key from a request,
writes one to a log, or has a hardcoded default — the LLM is disabled unless
the deployment explicitly sets both ``QENTOR_TUTOR_LLM_ENABLED`` and an API
key in the server's own environment. See ``backend/.env.example``.

A registry (not an if/else chain) keeps this open to another provider later
without the tutor's own logic caring which one is configured — it only ever
sees the ``LLMAdapter`` protocol.
"""

from __future__ import annotations

import os
from typing import Callable

from .llm import AnthropicAdapter, DEFAULT_MODEL, DEFAULT_OPENAI_COMPATIBLE_BASE_URL, LLMAdapter, OpenAICompatibleAdapter

ENABLE_LLM_ENV_VAR = "QENTOR_TUTOR_LLM_ENABLED"
PROVIDER_ENV_VAR = "QENTOR_TUTOR_LLM_PROVIDER"
API_KEY_ENV_VAR = "QENTOR_TUTOR_LLM_API_KEY"
MODEL_ENV_VAR = "QENTOR_TUTOR_LLM_MODEL"
BASE_URL_ENV_VAR = "QENTOR_TUTOR_LLM_BASE_URL"

DEFAULT_PROVIDER = "anthropic"

_PROVIDERS: dict[str, Callable[[str, str], LLMAdapter]] = {
    "anthropic": lambda api_key, model: AnthropicAdapter(api_key=api_key, model=model),
    # Groq, Cerebras, OpenRouter, Gemini (OpenAI endpoint) ... chosen by QENTOR_TUTOR_LLM_BASE_URL.
    "openai-compatible": lambda api_key, model: OpenAICompatibleAdapter(
        api_key=api_key,
        model=model,
        base_url=os.environ.get(BASE_URL_ENV_VAR, "").strip() or DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    ),
}


def llm_enabled() -> bool:
    return os.environ.get(ENABLE_LLM_ENV_VAR, "").strip().lower() in ("1", "true", "yes")


def build_default_llm_adapter() -> LLMAdapter | None:
    """The tutor's LLM layer, or ``None`` if it isn't configured.

    ``None`` here means "behave exactly as the deterministic-only milestone
    did" — the API layer must treat it as "no LLM available", not an error.
    """
    if not llm_enabled():
        return None

    api_key = os.environ.get(API_KEY_ENV_VAR, "").strip()
    if not api_key:
        return None

    provider = os.environ.get(PROVIDER_ENV_VAR, "").strip().lower() or DEFAULT_PROVIDER
    factory = _PROVIDERS.get(provider)
    if factory is None:
        return None

    model = os.environ.get(MODEL_ENV_VAR, "").strip()
    if not model:
        if provider != "anthropic":
            return None  # an OpenAI-compatible provider has no sensible default model: stay deterministic
        model = DEFAULT_MODEL
    return factory(api_key, model)
