"""Backend-owned challenges: definitions, deterministic evaluation, and the catalog.

Sits beside ``qentor.verification`` in the dependency order (api -> tutor -> verification/challenges -> execution ->
circuit): it imports the execution layer and the circuit model, never the tutor and never a provenance writer.
"""

from __future__ import annotations

from .evaluate import ChallengeEvaluation, CheckOutcome, Evidence, evaluate_challenge
from .models import Challenge, PublicChallenge, public_view
from .registry import CHALLENGE_BY_ID, CHALLENGES, get_challenge
