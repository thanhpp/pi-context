# LongMemEval-V2 local setup

## Result scope

This benchmark is a secondary retrieval proxy. It does not test coding-agent task success. Every Pi result is adapted and non-official. Do not compare it with leaderboard scores.

The accepted pilot uses four text-only cases: `05cce9b3`, `01307e07`, `07ab3723`, and `01f6e679`. The pilot omits `errors-gotchas`. All 29 image questions in the pinned snapshot use that type. The pilot does not test image questions or environment gotchas.

Full mode selects 422 eligible text-only small-tier questions and excludes 29 image questions. It does not score all 451 questions. Do not claim leaderboard equivalence or a 451-question score.

The runner writes one dated Markdown report for each invocation under `docs/benchmarks/`. The report records the dataset revision, source hashes, model, case counts, usage, cost states, and plugin Git revision or source fingerprint. This checkout has no Git HEAD. The current report must therefore use a plugin source fingerprint. A preflight report is not a successful benchmark. An incomplete report is not a complete score.

## External setup

Keep the upstream checkout, Python environment, dataset, and private run output outside the `pi-context` repository, except for the ignored `.benchmarks/` run-output directory. Install Python 3.11 first if `python3.11` is not available.

```sh
export LME_UPSTREAM="$HOME/benchmarks/LongMemEval-V2"
export DATA_ROOT="$HOME/benchmarks/longmemeval-v2"
mkdir -p "$HOME/benchmarks"
if [ ! -d "$LME_UPSTREAM/.git" ]; then
  git clone https://github.com/xiaowu0162/LongMemEval-V2 "$LME_UPSTREAM"
fi
git -C "$LME_UPSTREAM" checkout 2cc8c540bdb87fe6761629b585e727e1c4704520
test "$(git -C "$LME_UPSTREAM" rev-parse HEAD)" = "2cc8c540bdb87fe6761629b585e727e1c4704520"
export LME_VENV="$HOME/benchmarks/lme-venv"
python3.11 -m venv "$LME_VENV"
"$LME_VENV/bin/python" -m pip install -e "$LME_UPSTREAM"
"$LME_VENV/bin/python" -m pip install huggingface_hub
export PATH="$LME_VENV/bin:$PATH"
```

Download only the pinned text-only inputs. This call does not download screenshot archives.

```sh
"$LME_VENV/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id='xiaowu0162/longmemeval-v2',
    repo_type='dataset',
    revision='f152293e235517d504809563c833d7190b8c713b',
    local_dir=os.environ['DATA_ROOT'],
    allow_patterns=[
        'questions.jsonl',
        'trajectories.jsonl',
        'haystacks/lme_v2_small.json',
        'checksums.sha256',
        'LICENSE',
        'SCHEMA.md',
    ],
)
PY
(cd "$DATA_ROOT" && sha256sum -c --ignore-missing checksums.sha256)
```

Stop if any checksum fails. The upstream `data/download_data.py` downloads the complete snapshot, including screenshot archives. Do not use it for this text-only run. The upstream `data/validate_data.py --no-check-screenshots` still checks question-image paths. The local selected-case loader validates the chosen text-only inputs instead.

## Pilot manifest and offline checks

The approved pilot manifest is `scripts/longmemeval-v2/pilot.json`. The selector validates the pinned dataset and existing manifest. It writes the manifest only when the output file does not exist.

```sh
node --experimental-strip-types scripts/longmemeval-v2/select-pilot.ts \
  --data-root "$DATA_ROOT" \
  --output scripts/longmemeval-v2/pilot.json
```

Run the deterministic checks before any paid work. These commands do not call a model or download dataset files.

```sh
npm run check && npm test
```

## No-charge preflight

Log in with the OpenAI Codex subscription before the preflight and any paid run. Check the saved login without refreshing it. Check cached visibility for the semantic judge.

```sh
pi auth login --provider openai-codex
pi auth check --provider openai-codex --json --no-refresh
PI_OFFLINE=1 pi --offline --list-models gpt-6-sol
```

The no-refresh auth check and offline model listing make no model request. They do not prove live access or judge-model access during execution. The semantic judge is always `openai-codex/gpt-6-sol` at high reasoning effort. The benchmark command's `--thinking` value applies only to the answer model.

The accepted answer-model example uses `openai-codex/gpt-6-luna` with medium effort. Keep the answer model separate from the judge. The preflight checks visibility for both models.

Run the pilot preflight without `--execute`. The `.benchmarks/lme-v2` path is relative to the package root. The runner accepts this ignored output path and keeps each run private.

```sh
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-luna \
  --thinking medium \
  --output-root .benchmarks/lme-v2
```

A preflight validates local inputs, checks answer and judge model visibility, checks the local Pi auth file, checks Python 3.11, and measures available storage. It makes no model request. It does not test live access. The command reports `status: preflight` and writes a dated report under `docs/benchmarks/`.

Check that the pilot report lists four eligible cases and 29 excluded image cases. Check answer-model visibility, Pi auth-file state, storage, the judge visibility warning, and planned calls. The report warns that the judge is not visible only when the local Pi model list does not include `openai-codex/gpt-6-sol`. Other warnings can still appear. Do not continue if a required safety condition fails. The run needs at least 1 GiB of free output storage. Preflight estimates are not spend limits.

The pilot needs eight Pi answer requests: four memory answers and four question-only control answers. Memory mode also ingests the history for one 100-trajectory haystack in each selected domain. The report gives the number of history chunks. Each chunk needs one Pi request. The question-only controls do not pay for history ingestion. The selected `-abs` case needs up to two semantic judge calls, one per answer mode, before any evaluator retries.

Full mode is a separate preflight. It includes every eligible text-only small-tier question, but not the 29 image questions. It does not imply approval to execute the full set.

```sh
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set full \
  --model openai-codex/gpt-6-luna \
  --thinking medium \
  --output-root .benchmarks/lme-v2
```

To use Sol as the answer model, select its exact ID and check its visibility first. The next command does not switch models for you.

```sh
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-sol \
  --thinking medium \
  --output-root .benchmarks/lme-v2
```

## Paid pilot and resume

Run the paid pilot only after the offline checks pass, the no-charge preflight has no blocking condition, and the operator approves the exact model and run. Use the OpenAI Codex subscription login. Do not set `OPENAI_API_KEY` for benchmark scoring. The benchmark does not use a separate API key.

Semantic scoring keeps the pinned upstream abstention and gotchas rubrics, binary judgment parsing, and UNKNOWN handling. This adapted result changes the judge from the upstream GPT-5.2 API to `openai-codex/gpt-6-sol` at high effort. Deterministic rules remain local. If a semantic judge call fails after an answer exists, the runner scores that answer as incorrect and continues. This includes authentication, model access, transport, timeout, and invalid-output failures.

If shared Pi authentication is missing before answer generation, the report shows both modes of every unanswered case as incorrect and marks the run incomplete. Other answer or history failures also leave the run incomplete. Do not treat an incomplete run as a complete score.

```sh
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-luna \
  --thinking medium \
  --output-root .benchmarks/lme-v2 \
  --execute
```

To resume an incomplete pilot, set `RUN_NAME` to the value shown on the report's `Run` line. Use the same data, upstream revision, model, thinking level, and rate file. The run directory stays under the private output root.

```sh
RUN_NAME='pilot-<run-id>'
RUN_DIR="$PWD/.benchmarks/lme-v2/longmemeval-v2/$RUN_NAME"
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-luna \
  --thinking medium \
  --output-root .benchmarks/lme-v2 \
  --resume "$RUN_DIR" \
  --execute
```

Use the same explicit model for a Sol pilot and its resume. Do not resume a Luna run as Sol or change its input identity.

```sh
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-sol \
  --thinking medium \
  --output-root .benchmarks/lme-v2 \
  --execute

RUN_NAME='pilot-<run-id>'
RUN_DIR="$PWD/.benchmarks/lme-v2/longmemeval-v2/$RUN_NAME"
npm run benchmark:longmemeval-v2 -- \
  --data-root "$DATA_ROOT" \
  --upstream-root "$LME_UPSTREAM" \
  --set pilot \
  --model openai-codex/gpt-6-sol \
  --thinking medium \
  --output-root .benchmarks/lme-v2 \
  --resume "$RUN_DIR" \
  --execute
```

## Cost, storage, and privacy

The runner does not contain a USD price table for Luna or Sol. A displayed estimate can be unknown. Check the active account's rate before paid work. A Pi-reported USD field is recorded separately from an estimate. Do not substitute another model's rates.

A `--rates-json` file can give rates per million tokens. Store that file outside the repository and pass its absolute path with `--rates-json "$HOME/benchmarks/luna-rates.json"`. Use these exact field names. The four model fields apply to the selected Pi model. The judge fields provide an illustrative API-rate comparison for semantic judging. They do not describe a subscription charge.

```json
{
  "inputUsdPerMillionTokens": null,
  "outputUsdPerMillionTokens": null,
  "cacheReadUsdPerMillionTokens": null,
  "cacheWriteUsdPerMillionTokens": null,
  "judgeInputUsdPerMillionTokens": null,
  "judgeOutputUsdPerMillionTokens": null
}
```

If a rate is unknown, leave it `null` or omit it. The report then records USD as unknown. The semantic judge's rate-based USD estimate is an illustrative API-rate comparison, not a subscription charge. The rough estimate divides rendered UTF-8 history bytes by four for input tokens. It adds 1,024 input and 512 output tokens for each Pi session. It uses 1,024 input and 256 output tokens per semantic judge call. These assumptions are not maximums or spend caps. Actual ingestion tokens depend on chunking and model-selected writes. Record history ingestion cost separately from the paired answers. Controls have no ingestion cost.

The three dataset input files use about 1.2 GiB for `trajectories.jsonl`, plus smaller files. The upstream checkout, Python packages, run memory, and reports need more local storage. Download bandwidth and storage prices depend on the operator's service and hardware. The runner requires at least 1 GiB of free output storage before execution. The complete upstream downloader also transfers screenshot archives, which this setup avoids.

The runner sends benchmark inputs and answers to the authenticated Pi provider during execution. Follow applicable data-handling requirements and approve that use before a paid run. The runner creates private run directories with mode `0700` and private logs and checkpoint files with mode `0600`. It stores logs under `.benchmarks/`, which Git ignores. Logs can contain history and model answers. Do not copy raw logs, credentials, gold answers, or evaluator input into Git. Generated reports are sanitized and contain no raw logs or filesystem paths. Keep one dated report for each invocation.

The runner uses a private Pi agent directory and sets a 10 MiB quota for each benchmark domain project. It does not use normal project memory. Model-selected memory can exceed the quota and stop the run. Keep the failed checkpoint. Do not delete normal user memory with shell commands.

To inspect a benchmark project, use the matching `web` or `enterprise` fixture directory from the run and set `PI_CODING_AGENT_DIR` to that run's `agent` directory. Use the project ID in the report to identify the correct domain. This command can make a Pi request, so get separate approval first.

```sh
PROJECT_ROOT="$PWD"
cd "$RUN_DIR/fixtures/web"
PI_CODING_AGENT_DIR="$RUN_DIR/agent" pi \
  -e "$PROJECT_ROOT" \
  --tools pi_context \
  -p 'Use pi_context status only. Do not write, clean, or delete memory.'
```

Use the `enterprise` fixture directory for the enterprise project. Do not use the normal agent directory. Do not use `cleanup_apply` or remove memory files.

The report shows measured tokens, Pi-reported USD, rate-based cost states, case outcomes, and the plugin source fingerprint or Git revision. Keep the report with the matching source state. If the plugin has no Git HEAD, use its reported fingerprint. A partial report cannot be read as a complete score.

## Separate demo approval

`npm run demo` is a separate project-memory check. It makes two ordinary model requests. It is not part of LongMemEval-V2 and does not replace this proxy. It needs separate operator approval and an authenticated Pi main-model profile. Do not run it as part of benchmark approval.
