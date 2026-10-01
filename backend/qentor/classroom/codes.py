"""Class codes, capability tokens and anonymous aliases.

Everything here is a pure function of its input (or of ``secrets``): no I/O, no clock, no catalog.

* A **class code** is eight characters from a 31-symbol alphabet without look-alikes (no 0/O, 1/I/L), shown as ``ABCD-EFGH``. It is how a
  learner joins; it is NOT a credential for anything else (it opens no instructor view).
* An **instructor key** (``qi_...``) and a **learner token** (``ql_...``) are random bearer secrets (``secrets.token_urlsafe``, 192 bits). The
  server stores only their SHA-256, so a copy of the database is not a copy of any capability, and compares in constant time.
* A learner's **alias** (``Learner 4F2A``) is derived from the server-side learner id with a one-way hash: it is stable, it names nobody, and it
  cannot be turned back into the token.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
INSTRUCTOR_PREFIX = "qi_"
LEARNER_PREFIX = "ql_"
_TOKEN_BODY = r"[A-Za-z0-9_-]{32}"  # token_urlsafe(24) is exactly 32 characters
_RE_INSTRUCTOR = re.compile(rf"^{re.escape(INSTRUCTOR_PREFIX)}{_TOKEN_BODY}$")
_RE_LEARNER = re.compile(rf"^{re.escape(LEARNER_PREFIX)}{_TOKEN_BODY}$")
MAX_TITLE_LENGTH = 60


def new_class_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def format_code(code: str) -> str:
    """``ABCD-EFGH`` for the eight-character form."""
    return f"{code[:4]}-{code[4:]}"


def normalise_code(text: str) -> str | None:
    """The canonical eight characters for what a person typed (case, spaces and one hyphen ignored), or ``None`` when it cannot be a class code."""
    if not isinstance(text, str) or len(text) > 32:
        return None
    cleaned = re.sub(r"[\s-]", "", text).upper()
    if len(cleaned) != CODE_LENGTH or any(ch not in CODE_ALPHABET for ch in cleaned):
        return None
    return cleaned


def new_instructor_key() -> str:
    return INSTRUCTOR_PREFIX + secrets.token_urlsafe(24)


def new_learner_token() -> str:
    return LEARNER_PREFIX + secrets.token_urlsafe(24)


def is_instructor_key(text: object) -> bool:
    return isinstance(text, str) and bool(_RE_INSTRUCTOR.fullmatch(text))


def is_learner_token(text: object) -> bool:
    return isinstance(text, str) and bool(_RE_LEARNER.fullmatch(text))


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def secrets_match(secret: str, stored_hash: str) -> bool:
    """Constant-time comparison of a presented secret with the stored hash."""
    return hmac.compare_digest(hash_secret(secret), stored_hash)


def alias_for(learner_id: str) -> str:
    """``Learner 4F2A``: stable, one-way, names nobody."""
    digest = hashlib.sha256(("alias:" + learner_id).encode("utf-8")).hexdigest()
    return f"Learner {digest[:4].upper()}"


def clean_title(text: str | None) -> str:
    """A class title is optional free text from an instructor: control characters removed, whitespace collapsed, capped. It is only ever
    rendered as text."""
    if text is None:
        return ""
    cleaned = "".join(ch for ch in text if ch.isprintable())
    return re.sub(r"\s+", " ", cleaned).strip()[:MAX_TITLE_LENGTH]
