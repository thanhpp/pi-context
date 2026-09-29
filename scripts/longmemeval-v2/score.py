#!/usr/bin/env python3
"""Score one LongMemEval-V2 case with its pinned upstream evaluator."""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

UPSTREAM_COMMIT = "2cc8c540bdb87fe6761629b585e727e1c4704520"
SEMANTIC_EVALUATORS = {"llm_abstention_checker", "llm_gotchas_checker"}
CASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


@dataclass
class ScoreError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


def _signature_supports_call(function: Any, positional_names: tuple[str, ...], keyword_names: tuple[str, ...] = ()) -> bool:
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return False
    parameters = signature.parameters
    positional = [
        parameter
        for parameter in parameters.values()
        if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    if len(positional) < len(positional_names):
        return False
    if any(positional[index].name != name for index, name in enumerate(positional_names)):
        return False
    accepts_keywords = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values())
    return accepts_keywords or all(name in parameters for name in keyword_names)


def _load_upstream() -> ModuleType:
    configured_root = os.environ.get("LME_UPSTREAM", "").strip()
    if not configured_root:
        raise ScoreError("LME_UPSTREAM_NOT_CONFIGURED")
    root = Path(configured_root).expanduser()
    try:
        root = root.resolve(strict=True)
    except OSError:
        raise ScoreError("LME_UPSTREAM_PATH_INVALID") from None
    metrics_path = root / "evaluation" / "qa_eval_metrics.py"
    if not metrics_path.is_file():
        raise ScoreError("LME_UPSTREAM_EVALUATOR_MISSING")
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise ScoreError("LME_UPSTREAM_REVISION_UNAVAILABLE") from None
    if revision != UPSTREAM_COMMIT:
        raise ScoreError("LME_UPSTREAM_REVISION_MISMATCH")

    module_name = "_longmemeval_v2_pinned_qa_eval_metrics"
    spec = importlib.util.spec_from_file_location(module_name, metrics_path)
    if spec is None or spec.loader is None:
        raise ScoreError("LME_UPSTREAM_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise ScoreError(f"LME_UPSTREAM_IMPORT_FAILED_{type(error).__name__}") from None

    required_functions = {
        "extract_boxed_answer": (("text",), ()),
        "is_unknown": (("parsed_answer",), ()),
        "eval_name": (("eval_spec",), ()),
        "score_to_bool": (("score",), ()),
    }
    for name, (positional, keywords) in required_functions.items():
        function = getattr(module, name, None)
        if not callable(function) or not _signature_supports_call(function, positional, keywords):
            raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")

    eval_from_spec = getattr(module, "eval_from_spec", None)
    if not callable(eval_from_spec):
        raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")
    try:
        eval_signature = inspect.signature(eval_from_spec)
    except (TypeError, ValueError):
        raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR") from None
    eval_parameters = eval_signature.parameters
    if (
        not eval_parameters
        or next(iter(eval_parameters.values())).name != "spec"
        or not any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in eval_parameters.values())
        or not any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in eval_parameters.values())
    ):
        raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")

    for name in SEMANTIC_EVALUATORS:
        function = getattr(module, name, None)
        if not callable(function) or not _signature_supports_call(
            function,
            ("prediction", "answer"),
            (
                "question_item",
                "parsed_prediction",
                "model_response",
                "evaluator_model",
                "evaluator_api_key",
                "evaluator_reasoning_effort",
            ),
        ):
            raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")
    return module


def _require_question(question: Any) -> tuple[str, str, str]:
    if not isinstance(question, dict):
        raise ScoreError("CASE_INVALID")
    case_id = question.get("id")
    answer = question.get("answer")
    eval_function = question.get("eval_function")
    if not isinstance(case_id, str) or not CASE_ID_PATTERN.fullmatch(case_id):
        raise ScoreError("CASE_ID_INVALID")
    if not isinstance(answer, str) or not isinstance(eval_function, str) or not eval_function.strip():
        raise ScoreError("CASE_INVALID")
    return case_id, answer, eval_function


def _answer_metadata(metrics: ModuleType, eval_function: str, response_raw: str) -> tuple[str, str, bool]:
    try:
        parsed_answer = metrics.extract_boxed_answer(response_raw)
        evaluator_name = metrics.eval_name(eval_function)
        if not isinstance(parsed_answer, str) or not isinstance(evaluator_name, str) or not evaluator_name:
            raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")
        is_unknown = metrics.is_unknown(parsed_answer)
        if not isinstance(is_unknown, bool):
            raise ScoreError("EVALUATOR_COMPATIBILITY_ERROR")
    except ScoreError:
        raise
    except Exception as error:
        raise ScoreError(f"EVALUATION_FAILED_{type(error).__name__}") from None
    return parsed_answer, evaluator_name, is_unknown


def prepare_semantic_case(question: Any, response_raw: Any) -> dict[str, Any]:
    case_id, _answer, eval_function = _require_question(question)
    if not isinstance(response_raw, str):
        raise ScoreError("RESPONSE_INVALID")

    metrics = _load_upstream()
    parsed_answer, evaluator_name, is_unknown = _answer_metadata(metrics, eval_function, response_raw)
    if evaluator_name not in SEMANTIC_EVALUATORS:
        raise ScoreError("SEMANTIC_EVALUATOR_REQUIRED")
    return {
        "id": case_id,
        "evalName": evaluator_name,
        "parsedAnswer": parsed_answer,
        "isUnknown": is_unknown,
    }


def score_case(
    question: dict[str, Any],
    response_raw: str,
    *,
    execute: bool,
    evaluator_model: str = "gpt-5.2",
) -> dict[str, Any]:
    case_id, answer, eval_function = _require_question(question)
    if not isinstance(response_raw, str):
        raise ScoreError("RESPONSE_INVALID")
    if not isinstance(execute, bool):
        raise ScoreError("EXECUTION_FLAG_INVALID")
    if not isinstance(evaluator_model, str) or not evaluator_model.strip():
        raise ScoreError("EVALUATOR_MODEL_INVALID")

    metrics = _load_upstream()
    parsed_answer, evaluator_name, is_unknown = _answer_metadata(metrics, eval_function, response_raw)

    semantic = evaluator_name in SEMANTIC_EVALUATORS
    evaluator_kwargs: dict[str, Any] = {}
    prediction_for_eval = parsed_answer
    if semantic:
        if not execute:
            raise ScoreError("SEMANTIC_EXECUTION_REQUIRED")
        raise ScoreError("SEMANTIC_RUNNER_REQUIRED")

    try:
        raw_score = metrics.eval_from_spec(eval_function, prediction_for_eval, answer, **evaluator_kwargs)
        score = metrics.score_to_bool(raw_score)
    except ScoreError:
        raise
    except Exception as error:
        raise ScoreError(f"EVALUATION_FAILED_{type(error).__name__}") from None

    if is_unknown:
        score = False
    return {
        "id": case_id,
        "score": score,
        "evalName": evaluator_name,
        "parsedAnswer": parsed_answer,
        "isUnknown": is_unknown,
        "semanticJudge": semantic,
        "judgeUsage": None if semantic else {"callCount": 0},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Score one LongMemEval-V2 case from JSON stdin.")
    parser.add_argument("--execute", action="store_true", help="Retain the legacy semantic execution flag.")
    parser.add_argument("--prepare-semantic", action="store_true", help="Prepare semantic answer metadata without scoring.")
    parser.add_argument("--evaluator-model", default="gpt-5.2")
    args = parser.parse_args()

    question: Any = None
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ScoreError("INPUT_INVALID")
        question = payload.get("question")
        response_raw = payload.get("responseRaw")
        if not isinstance(response_raw, str):
            raise ScoreError("RESPONSE_INVALID")
        if args.prepare_semantic:
            result = prepare_semantic_case(question, response_raw)
        else:
            result = score_case(
                question,
                response_raw,
                execute=args.execute,
                evaluator_model=args.evaluator_model,
            )
    except ScoreError as error:
        raw_id = question.get("id") if isinstance(question, dict) else None
        case_id = raw_id if isinstance(raw_id, str) and CASE_ID_PATTERN.fullmatch(raw_id) else "<unknown>"
        print(f"SCORE_ERROR case_id={case_id} code={error.code}", file=sys.stderr)
        return 1
    except Exception as error:
        raw_id = question.get("id") if isinstance(question, dict) else None
        case_id = raw_id if isinstance(raw_id, str) and CASE_ID_PATTERN.fullmatch(raw_id) else "<unknown>"
        print(f"SCORE_ERROR case_id={case_id} code=INPUT_FAILED_{type(error).__name__}", file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
