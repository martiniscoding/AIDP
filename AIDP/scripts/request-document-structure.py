"""Read a rendered request with the engine's own Word parser and print what it found.

The companion to verify-request-document.mts, which generates the document and
checks this output. It lives here, beside its caller, rather than in Workers/:
what is under test is the *app's* rendering, and the parser is the fixed thing
it is being tested against.

Imports the real Workers package — not a copy of it, and not a description of
what it does. A test that reimplements the parser proves the test agrees with
itself.

    python3 scripts/request-document-structure.py <path-to-docx> <workers-dir>
"""

import json
import sys

sys.path.insert(0, sys.argv[2])

from aidp.parsing import docs, sections  # noqa: E402 — the path has to be set first

doc = docs.read(open(sys.argv[1], "rb").read())
tree, _owner = sections.from_outline(doc.lines, doc.levels, document_title=doc.title or "")

print(
    json.dumps(
        {
            "title": doc.title,
            "headings": len(doc.levels),
            "sections": [
                {
                    "ordinal": s.ordinal,
                    "number": s.number_text,
                    "title": s.title,
                    "depth": s.depth,
                    "path": s.heading_path,
                    "text": s.text,
                }
                for s in tree
            ],
        }
    )
)
