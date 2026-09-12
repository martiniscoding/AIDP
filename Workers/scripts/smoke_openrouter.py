"""Smoke test for the OpenRouter provider — no network, no database.

What has to hold for OpenRouter to carry every model call and every vector:

  · schemas            the Gemini-shaped schemas become strict JSON Schema —
                       every object closed, every property required, optional
                       values spelt as a union with null
  · every request      is sent with `data_collection: deny` and pinned to the
                       configured hosts, and a schema request only goes to a
                       host that honours the schema
  · replies            are read whether content arrives as a string or as parts;
                       an empty reply is an error where a verdict is needed
  · the bill           is recorded from the response's own token counts
  · failures           an account out of credits stops at once and says so,
                       and a request the provider refuses is not retried four
                       times over
  · embeddings         ask for the column's width, come back in input order,
                       and a short reply is an error rather than a misaligned write

    PYTHONPATH=Workers python3 Workers/scripts/smoke_openrouter.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("STAGE", "analyse")
os.environ.setdefault("DATABASE_URL", "postgresql://smoke/test")
# Pinned rather than defaulted: Workers/.env is loaded into this process too.
os.environ["LLM_PROVIDER"] = "openrouter"
os.environ["OPENROUTER_API_KEY"] = "test-key"
os.environ["OPENROUTER_MODEL"] = "openai/gpt-4.1-mini"
os.environ["OPENROUTER_FAST_MODEL"] = "openai/gpt-4.1-nano"
os.environ["OPENROUTER_PROVIDERS"] = "openai,azure"
os.environ["OPENROUTER_ZDR"] = "off"
os.environ["EMBEDDING_PROVIDER"] = "openrouter"
os.environ["EMBEDDING_MODEL"] = "openai/text-embedding-3-large"
os.environ["EMBEDDING_DIMS"] = "1024"

import httpx  # noqa: E402

from aidp import usage  # noqa: E402
from aidp.ai import embeddings, llm  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def walk(node, path="$"):
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from walk(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, f"{path}[{index}]")


# ---------------------------------------------------------------------------
print("\n1. Schemas become strict JSON Schema")
for name, schema in [
    ("rules", llm._RULES_SCHEMA),
    ("verdict", llm._VERDICT_SCHEMA),
    ("structure", llm._STRUCTURE_SCHEMA),
]:
    strict = llm._strict_schema(schema)
    objects = [(p, n) for p, n in walk(strict) if n.get("type") == "object"]
    ok(f"{name}: every object is closed and requires all its properties",
       objects and all(
           n.get("additionalProperties") is False
           and sorted(n.get("required", [])) == sorted(n.get("properties", {}))
           for _, n in objects
       ), [p for p, n in objects if n.get("additionalProperties") is not False])
    ok(f"{name}: no Gemini-only keywords survive",
       not any("propertyOrdering" in n or "nullable" in n for _, n in walk(strict)))
rules_item = llm._strict_schema(llm._RULES_SCHEMA)["properties"]["rules"]["items"]
ok("an optional heading becomes integer-or-null, and is still required",
   rules_item["properties"]["heading"]["type"] == ["integer", "null"]
   and "heading" in rules_item["required"], rules_item["properties"]["heading"])
ok("the source schema is left untouched",
   "propertyOrdering" in llm._RULES_SCHEMA and "additionalProperties" not in llm._RULES_SCHEMA)
odd = llm._strict_schema({"type": "object", "properties": {"type": {"type": "string"}}})
ok("a property named 'type' is treated as a property, not a keyword",
   odd["properties"]["type"] == {"type": "string"} and odd["required"] == ["type"], odd)


# ---------------------------------------------------------------------------
print("\n2. Requests")
sent: list[dict] = []
recorded: list[dict] = []
replies: list[dict] = []


def fake_post(url, headers, payload, attempts=4):
    sent.append({"url": url, "headers": headers, "payload": payload, "attempts": attempts})
    return replies.pop(0) if len(replies) > 1 else replies[0]


def reply(content, *, finish="stop", prompt=120, completion=30):
    return {
        "model": "openai/gpt-4.1-mini",
        "choices": [{"message": {"content": content}, "finish_reason": finish}],
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "cost": 0.0001},
    }


llm._post = fake_post
usage.record = lambda **kwargs: recorded.append(kwargs)
client = llm.OpenRouterLLM(
    "test-key", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano", providers=("openai", "azure")
)

verdict = {"verdict": "covered", "confidence": 0.9, "rationale": "Stated.",
           "evidence": ["E1"], "appliedDecisions": []}
replies[:] = [reply(json.dumps(verdict))]
result = client.judge(reference="3.2", clause="MFA required", extracts="E1: MFA everywhere")
request = sent[-1]
payload = request["payload"]
ok("goes to OpenRouter's chat endpoint with the key as a bearer token",
   request["url"] == "https://openrouter.ai/api/v1/chat/completions"
   and request["headers"]["Authorization"] == "Bearer test-key")
ok("uses the main model for a verdict", payload["model"] == "openai/gpt-4.1-mini")
ok("asks for strict schema output",
   payload["response_format"]["type"] == "json_schema"
   and payload["response_format"]["json_schema"]["strict"] is True
   and payload["response_format"]["json_schema"]["name"] == "verdict")
ok("never to a host that trains on prompts, only the pinned hosts",
   payload["provider"]["data_collection"] == "deny"
   and payload["provider"]["only"] == ["openai", "azure"], payload["provider"])
ok("only to a host that honours the schema", payload["provider"].get("require_parameters") is True)
ok("zero-data-retention not demanded unless configured", "zdr" not in payload["provider"])
ok("the verdict is parsed", result == verdict, result)
ok("the bill is recorded from the response's own counts",
   recorded[-1] == {"kind": "llm", "provider": "openrouter", "model": "openai/gpt-4.1-mini",
                    "input_tokens": 120, "output_tokens": 30}, recorded[-1])

replies[:] = [reply('{"sections": [], "labels": [], "rules": []}')]
raw = client.read_rules(document="0: x", title="T", first=0, last=0, whole=True, attempt=2)
payload = sent[-1]["payload"]
ok("rules: raw reply returned for storage", raw.startswith('{"sections"'), raw)
ok("rules: the cross-check reading is sampled, with room for a long reply",
   payload["temperature"] == 0.5 and payload["max_tokens"] == llm._RULES_MAX_TOKENS
   and payload["max_tokens"] <= 32_768, payload)
ok("rules: transport retries capped, rules.py retries itself", sent[-1]["attempts"] == 2)

replies[:] = [reply("Sits under 3.2, on privileged access.")]
client.contextualise("THE DOCUMENT", "a chunk", title="Security")
payload = sent[-1]["payload"]
ok("preambles use the fast model", payload["model"] == "openai/gpt-4.1-nano")
ok("the document leads, so every preamble in it shares a cached prefix",
   payload["messages"][0]["role"] == "system"
   and "THE DOCUMENT" in payload["messages"][0]["content"]
   and "a chunk" in payload["messages"][1]["content"])
ok("no schema, so no parameter requirement", "require_parameters" not in payload["provider"])

replies[:] = [reply("NO_INFORMATION")]
described = client.describe_figure(b"\x89PNG", heading_path="A › B", caption=None)
image = sent[-1]["payload"]["messages"][0]["content"][1]
ok("figures are sent inline as a data URL",
   image["type"] == "image_url" and image["image_url"]["url"].startswith("data:image/png;base64,"))
ok("a decorative figure reads as nothing", described == "")

replies[:] = [reply([{"type": "text", "text": "Part one. "}, {"type": "text", "text": "Two."}])]
ok("content arriving as parts is joined",
   client.summarise("doc", title="T") == "Part one. Two.")

replies[:] = [{"choices": [], "usage": {}}]
try:
    client.judge(reference="r", clause="c", extracts="e")
    ok("an empty verdict is an error, not a silent pass", False)
except RuntimeError:
    ok("an empty verdict is an error, not a silent pass", True)

strict_client = llm.OpenRouterLLM("k", "m", "f", providers=(), zdr=True)
replies[:] = [reply("fine")]
strict_client.summarise("doc", title="T")
provider = sent[-1]["payload"]["provider"]
ok("zero data retention demanded when configured, and no pin when none is set",
   provider.get("zdr") is True and "only" not in provider, provider)


# ---------------------------------------------------------------------------
print("\n3. Failures")


class FakeResponse:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)
        self.request = httpx.Request("POST", "https://openrouter.ai")
        self.headers: dict = {}

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                self.text, request=self.request, response=httpx.Response(self.status_code)
            )


class FakeClient:
    responses: list[FakeResponse] = []
    posts = 0

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args) -> bool:
        return False

    def post(self, url, headers=None, json=None):  # noqa: A002 — httpx's own name
        FakeClient.posts += 1
        if len(FakeClient.responses) > 1:
            return FakeClient.responses.pop(0)
        return FakeClient.responses[0]


llm.httpx.Client = FakeClient
embeddings.httpx.Client = FakeClient
llm.time.sleep = lambda seconds: None
embeddings.time.sleep = lambda seconds: None

# `_post` was replaced above for the request tests; reload the real one.
import importlib  # noqa: E402

llm_module = importlib.reload(llm)
llm_module.httpx.Client = FakeClient
llm_module.time.sleep = lambda seconds: None

FakeClient.responses, FakeClient.posts = [FakeResponse(402, {"error": {"message": "credits"}})], 0
try:
    llm_module._post("https://openrouter.ai/api/v1/chat/completions", {}, {}, attempts=4)
    ok("an account out of credits stops at once", False)
except llm_module.QuotaExhausted as exc:
    ok("an account out of credits stops at once, and says so",
       FakeClient.posts == 1 and "credit" in str(exc), (FakeClient.posts, exc))

FakeClient.responses = [FakeResponse(400, {"error": {"message": "bad schema"}})]
FakeClient.posts = 0
try:
    llm_module._post("https://openrouter.ai/api/v1/chat/completions", {}, {}, attempts=4)
    ok("a refused request is not retried", False)
except llm_module.QuotaExhausted:
    ok("a refused request is not retried", False, "raised QuotaExhausted")
except RuntimeError as exc:
    ok("a refused request is not retried, and keeps the provider's reason",
       FakeClient.posts == 1 and "bad schema" in str(exc), (FakeClient.posts, exc))

FakeClient.responses = [
    FakeResponse(500, {"error": "busy"}),
    FakeResponse(200, reply("recovered")),
]
FakeClient.posts = 0
data = llm_module._post("https://openrouter.ai/api/v1/chat/completions", {}, {}, attempts=4)
ok("a server error is retried, and the retry used",
   FakeClient.posts == 2 and data["choices"][0]["message"]["content"] == "recovered")

FakeClient.responses, FakeClient.posts = [FakeResponse(402, {"error": {"message": "credits"}})], 0
try:
    embeddings._post_with_retry("https://openrouter.ai/api/v1/embeddings", {}, {}, attempts=5)
    ok("embeddings: out of credits stops at once", False)
except RuntimeError as exc:
    ok("embeddings: out of credits stops at once, and says so",
       FakeClient.posts == 1 and "credit" in str(exc), (FakeClient.posts, exc))


# ---------------------------------------------------------------------------
print("\n4. Configuration")
llm_module._client = None
ok("openrouter is available with its key", llm_module.available())
ok("and is the client", isinstance(llm_module.client(), llm_module.OpenRouterLLM))
ok("the model recorded against a run is the configured one",
   llm_module.model_name() == ("openrouter", "openai/gpt-4.1-mini"), llm_module.model_name())
ok("the client carries the pinned hosts",
   llm_module.client().providers == ("openai", "azure") and llm_module.client().zdr is False)
ok("usage reads OpenAI-shaped counts",
   usage.from_openai({"usage": {"prompt_tokens": 7, "completion_tokens": 3}}) == (7, 3)
   and usage.from_openai({}) == (0, 0))


# ---------------------------------------------------------------------------
print("\n5. Embeddings")
posted: list[dict] = []


def fake_embed_post(url, headers, payload, attempts=5):
    posted.append({"url": url, "headers": headers, "payload": payload})
    count = len(payload["input"])
    # Deliberately out of order: the index, not the position, is the truth.
    return {"data": [{"index": i, "embedding": [float(i)] * 1024} for i in reversed(range(count))]}


embeddings._post_with_retry = fake_embed_post
prov = embeddings.provider()
ok("openrouter is the embedding provider", isinstance(prov, embeddings.OpenRouterProvider))
vectors = prov.embed(["a", "b", "c"], "document")
request = posted[-1]
ok("asks for the column's width from the configured model",
   request["payload"]["dimensions"] == 1024
   and request["payload"]["model"] == "openai/text-embedding-3-large")
ok("sent with the same data policy and pinned hosts as model calls",
   request["payload"]["provider"] == {"data_collection": "deny", "only": ["openai", "azure"]},
   request["payload"]["provider"])
ok("vectors come back in input order", [v[0] for v in vectors] == [0.0, 1.0, 2.0])

embeddings._post_with_retry = lambda url, headers, payload, attempts=5: {
    "data": [{"index": 0, "embedding": [0.0] * 1024}]
}
try:
    prov.embed(["a", "b"], "query")
    ok("a short reply is an error, never a misaligned write", False)
except RuntimeError:
    ok("a short reply is an error, never a misaligned write", True)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
