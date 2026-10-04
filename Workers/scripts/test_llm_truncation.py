"""A reply that stopped at its limit is asked again with room to finish.

No network: the provider is replaced with canned responses. What is under test is
what `_chat` does with a reply whose `finish_reason` is "length" — on a real run
that reached a customer's report as "this clause could not be judged", because a
cut-off reply is not JSON and the caller could not tell that from a bad answer.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e LLM_PROVIDER=openrouter -e OPENROUTER_API_KEY=stub \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test scripts/test_llm_truncation.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.ai import llm  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


WHOLE = '{"verdict":"partial","confidence":0.9,"rationale":"Short enough.","evidence":[]}'
STUMP = '{"verdict":"partial","confidence":0.9,"rationale":"It went on and on and'


def reply(content: str, finish: str) -> dict:
    return {
        "choices": [{"finish_reason": finish, "message": {"content": content}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        "model": "openai/gpt-4.1-mini",
    }


def provider(*replies: dict):
    """Stands in for the HTTP call, and records what each attempt asked for."""
    asked: list[dict] = []
    remaining = list(replies)

    def post(url, headers, payload, attempts=4):  # noqa: ARG001
        asked.append(payload)
        return remaining.pop(0) if remaining else replies[-1]

    return asked, post


client = llm.OpenRouterLLM("stub-key", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano")
real_post = llm._post

print("\nA reply cut off at the limit")
asked, llm._post = provider(reply(STUMP, "length"), reply(WHOLE, "stop"))
try:
    text = client._chat([{"role": "user", "content": "go"}], max_tokens=2048, name="verdict")
finally:
    llm._post = real_post

ok("is asked again rather than handed back in pieces", text == WHOLE, text)
ok("twice, not more", len(asked) == 2, len(asked))
ok("the second attempt has room to finish", asked[1]["max_tokens"] == 4096, asked[1]["max_tokens"])
ok(
    "and is otherwise the same request",
    asked[1]["messages"] == asked[0]["messages"] and asked[1]["model"] == asked[0]["model"],
    (asked[0].get("model"), asked[1].get("model")),
)

print("\nA model that will not stop")
asked, llm._post = provider(reply(STUMP, "length"), reply(STUMP, "length"))
try:
    text = client._chat([{"role": "user", "content": "go"}], max_tokens=2048, name="verdict")
finally:
    llm._post = real_post
ok("is not asked a third time", len(asked) == 2, len(asked))
ok("and what came back is left to the caller to refuse", text == STUMP, text)

print("\nA reply that finished")
asked, llm._post = provider(reply(WHOLE, "stop"))
try:
    text = client._chat([{"role": "user", "content": "go"}], max_tokens=2048, name="verdict")
finally:
    llm._post = real_post
ok("is asked for once", len(asked) == 1 and text == WHOLE, (len(asked), text))

print("\nThe ceiling")
asked, llm._post = provider(reply(STUMP, "length"), reply(WHOLE, "stop"))
try:
    client._chat([{"role": "user", "content": "go"}], max_tokens=llm._LENGTH_CEILING, name="x")
finally:
    llm._post = real_post
ok("a request already at the ceiling is not doubled past it", len(asked) == 1, len(asked))

print("\nWhat each model is sent")
llm._CAPABILITIES = {
    "openai/gpt-4.1-mini": {"temperature", "seed", "response_format", "max_tokens"},
    "reasoning/model": {"seed", "response_format", "max_tokens"},
}
asked, llm._post = provider(reply(WHOLE, "stop"))
try:
    client._chat([{"role": "user", "content": "go"}], max_tokens=512, name="verdict")
finally:
    llm._post = real_post
ok("a model that takes temperature is sent it", asked[0].get("temperature") == 0.0, asked[0])

asked, llm._post = provider(reply(WHOLE, "stop"))
try:
    client._chat(
        [{"role": "user", "content": "go"}],
        max_tokens=512,
        model="reasoning/model",
        schema={"type": "object", "properties": {}, "required": []},
        name="verdict",
    )
finally:
    llm._post = real_post
ok(
    "a model that does not is sent the rest without it",
    "temperature" not in asked[0] and asked[0].get("seed") == llm._SEED,
    asked[0],
)
ok(
    "and the schema keeps its own name",
    asked[0]["response_format"]["json_schema"]["name"] == "verdict",
    asked[0].get("response_format"),
)

asked, llm._post = provider(reply(WHOLE, "stop"))
try:
    client._chat([{"role": "user", "content": "go"}], max_tokens=512, model="nobody/knows")
finally:
    llm._post = real_post
ok(
    "a model the catalogue has never heard of is sent everything, as before",
    asked[0].get("temperature") == 0.0 and asked[0].get("seed") == llm._SEED,
    asked[0],
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
