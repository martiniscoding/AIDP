"""A technology the design names and the stack has never heard of is reported, checked in code.

EA-007 and EA-008 turn on Mirth Connect, which the design names eighteen times
and the technology stack does not contain. `names_in` only reports technologies
that ARE in the stack, so absence was left for the judge to infer from a list of
two hundred names, and it answered "all technologies are listed".

The model proposes names; `stack.unlisted` never trusts one. A name counts only
if it is literally in the design and no stack row matches it.

No database, no model, no network.

    python tests/test_stack_unlisted.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import stack  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


STACK = stack.Stack(
    rows=[
        stack.Row(name="Amazon Redshift", status="hold"),
        stack.Row(name="Amazon EventBridge", status="adopt"),
        stack.Row(name="PostgreSQL (Aurora / RDS)", status="adopt"),
        stack.Row(name="Amazon Elastic Kubernetes Service", status="adopt"),
        stack.Row(name="AWS Step Functions", status="adopt"),
        stack.Row(name="Amazon ElastiCache (Redis)", status="adopt"),
    ]
)
TEXT = (
    "Integration layer: Amazon EventBridge, SQS/SNS, Mirth Connect, SFTP gateway. "
    "Analytics marts run on Amazon Redshift. Orders are stored in PostgreSQL."
)

print("\nWhat is reported")
found = stack.unlisted(STACK, TEXT, ["Mirth Connect", "Amazon Redshift", "Amazon EventBridge"])
ok("a name no stack row matches is reported", [h.row.name for h in found] == ["Mirth Connect"], found)
ok("with the design's own words beside it", bool(found) and "Mirth Connect" in found[0].quote)
ok(
    "a stack technology is not reported, whatever its status",
    "Amazon Redshift" not in [h.row.name for h in found],
)
ok(
    "a bracketed stack name matches on its primary name",
    stack.unlisted(STACK, TEXT, ["PostgreSQL"]) == [],
)

print("\nA stack technology written differently is not reported as missing")
spelled = "EKS runs the services. Step Functions orchestrate refunds. Redis holds sessions. Mirth Connect is used."
left = stack.unlisted(STACK, spelled, ["EKS", "Step Functions", "Redis", "Mirth Connect"])
ok("an acronym of a stack name is recognised", "EKS" not in [h.row.name for h in left], left)
ok("a part of a stack name is recognised", "Step Functions" not in [h.row.name for h in left], left)
ok("a name in a stack bracket is recognised", "Redis" not in [h.row.name for h in left], left)
ok("and the one the stack lacks still is reported", [h.row.name for h in left] == ["Mirth Connect"], left)

print("\nWhat is refused")
ok(
    "a name the model invented, that is not in the design, is dropped",
    stack.unlisted(STACK, TEXT, ["Kafka Streams Pro"]) == [],
)
ok("an empty or tiny name is dropped", stack.unlisted(STACK, TEXT, ["", "  ", "Mi"]) == [])
ok(
    "a repeated name is reported once",
    len(stack.unlisted(STACK, TEXT, ["Mirth Connect", "mirth connect", "Mirth  Connect"])) == 1,
)
many_text = " ".join(f"Tool{i:02d}x" for i in range(40))
many = stack.unlisted(stack.Stack(rows=[]), many_text, [f"Tool{i:02d}x" for i in range(40)])
ok("the list is capped", len(many) == stack.MAX_UNLISTED, len(many))

print("\nHow it is shown to the judge")
block = stack.render(STACK, stack.names_in(STACK, TEXT), found)
ok("the block names the unmatched technology", "Mirth Connect" in block)
ok("and tells the judge the stack may spell it differently", "write a name differently" in block)
ok("with no verdict in it", "breach" not in block.lower() and "contradict" not in block.lower())
ok(
    "nothing unmatched leaves the block as it was",
    stack.render(STACK, stack.names_in(STACK, TEXT), None) == stack.render(STACK, stack.names_in(STACK, TEXT), []),
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
