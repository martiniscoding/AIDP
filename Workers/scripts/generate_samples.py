"""Generate the sample corpus: three standards and two designs to assess.

    docker run --rm -v "$PWD/..":/dexter -w /dexter/Workers \
      --entrypoint python aidp-worker:dev scripts/generate_samples.py

Writes to ../samples. The standards are the base an assessment measures
against; the designs are what gets measured. They are written against each
other on purpose, so ANSWER_KEY.md can state the correct verdict for every
clause worth checking — which is what turns "the assessment ran" into "the
assessment was right".
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.samples import designs, standards  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "../samples")


def main() -> int:
    (OUT / "standards").mkdir(parents=True, exist_ok=True)
    (OUT / "designs").mkdir(parents=True, exist_ok=True)

    jobs = [
        (standards.data_standards, OUT / "standards" / "Data_Standards.pdf"),
        (standards.security_standards, OUT / "standards" / "Security_Standards.pdf"),
        (
            standards.architecture_standards,
            OUT / "standards" / "Solution_Architecture_Standards.pdf",
        ),
        (designs.customer_portal, OUT / "designs" / "Customer_Portal_Modernisation_SAD.pdf"),
        (designs.field_telemetry, OUT / "designs" / "Field_Telemetry_Ingestion_SAD.pdf"),
    ]

    import fitz

    for build, path in jobs:
        build(str(path))
        doc = fitz.open(path)
        chars = sum(len(doc[i].get_text()) for i in range(doc.page_count))
        size_kb = path.stat().st_size // 1024
        print(
            f"  {path.name:<48} {doc.page_count:>2} pages  "
            f"{size_kb:>4} KB  {chars:>6} chars"
        )
        doc.close()

    print(f"\nWrote {len(jobs)} PDFs to {OUT.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
