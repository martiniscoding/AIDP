"""The technology support check, with no internet and no database.

endoflife.date is replaced by a fake `httpx.get` that records every URL asked
for, so "nothing from the design leaves this system" is checked against the
actual requests rather than assumed. The model's reply is scripted, so what this
proves is what the code does with a reply: ids not on the list are never looked
up, a version not in the design's words is not reported on, and each status is
worked out correctly on a fixed day.

    docker run --rm -v "$PWD/Workers":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python workers-analyse scripts/smoke_lifecycle.py
"""

from __future__ import annotations

import contextlib
import dataclasses
import datetime as dt
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from aidp import coverage, db, lifecycle, whole_document  # noqa: E402
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


TODAY = dt.date(2026, 9, 19)

# endoflife.date as it answered on the day these were written, trimmed.
PRODUCTS = {
    "schema_version": "1.2.0",
    "result": [
        {"name": "postgresql", "label": "PostgreSQL", "aliases": ["postgres", "pg"]},
        {"name": "angular", "label": "Angular", "aliases": []},
        {"name": "spring-boot", "label": "Spring Boot", "aliases": ["springboot"]},
        {"name": "eclipse-temurin", "label": "Eclipse Temurin", "aliases": ["temurin"]},
        {"name": "rabbitmq", "label": "RabbitMQ", "aliases": []},
        {"name": "Bad Id!", "label": "Never a URL", "aliases": []},
    ],
}
RELEASES = {
    "postgresql": [
        {"cycle": "18", "eol": "2030-11-14", "latest": "18.6", "lts": False},
        {"cycle": "17", "eol": "2029-11-08", "latest": "17.11", "lts": False},
        {"cycle": "12", "eol": "2024-11-21", "latest": "12.22", "lts": False},
        {"cycle": "11", "eol": "2023-11-09", "latest": "11.22", "lts": False},
    ],
    "angular": [
        {"cycle": "20", "eol": "2026-11-28", "support": "2025-11-28", "latest": "20.3.4",
         "lts": "2025-11-28", "extendedSupport": False},
        {"cycle": "12", "eol": "2022-11-12", "support": "2021-11-12", "latest": "12.2.17",
         "lts": False, "extendedSupport": True},
    ],
    "spring-boot": [
        {"cycle": "3.5", "eol": "2026-06-30", "latest": "3.5.9", "lts": False},
        {"cycle": "2.7", "eol": "2023-06-30", "latest": "2.7.18", "lts": False,
         "extendedSupport": "2029-06-30"},
        {"cycle": "2.6", "eol": "2022-11-24", "latest": "2.6.15", "lts": False},
    ],
    "eclipse-temurin": [
        {"cycle": "25", "eol": "2031-09-30", "latest": "25.0.1", "lts": True},
        {"cycle": "24", "eol": "2025-09-16", "latest": "24.0.2", "lts": False},
        {"cycle": "8", "eol": "2030-12-31", "latest": "8u504-b01", "lts": True},
    ],
}


class FakeResponse:
    def __init__(self, status: int, data=None):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=None)  # type: ignore[arg-type]


requested: list[str] = []
broken: set[str] = set()


def fake_get(url, **kwargs):
    requested.append(url)
    path = url.split("/api/", 1)[1]
    if path in broken:
        raise httpx.ConnectTimeout("timed out")
    if path == "v1/products":
        return FakeResponse(200, PRODUCTS)
    product = path.removesuffix(".json")
    if product in RELEASES:
        return FakeResponse(200, RELEASES[product])
    return FakeResponse(404)


def fresh_fetches() -> None:
    requested.clear()
    broken.clear()
    lifecycle._held.clear()


httpx.get = fake_get  # lifecycle calls httpx.get through the module

# ------------------------------------------------------------------ #
print("\nMatching a stated version to a release line")
PG = RELEASES["postgresql"]
SB = RELEASES["spring-boot"]
TM = RELEASES["eclipse-temurin"]
for version, cycles, expected in (
    ("11", PG, "11"),
    ("11.4", PG, "11"),
    ("v17", PG, "17"),
    ("2.7.18", SB, "2.7"),
    ("2.7", SB, "2.7"),
    ("1.8", TM, "8"),
    ("8u292", TM, "8"),
):
    release, _ = lifecycle.match_cycle(version, cycles)
    ok(f"{version!r} is line {expected}", release is not None and release["cycle"] == expected,
       release and release["cycle"])
release, wider = lifecycle.match_cycle("2", SB)
ok("'2' is ambiguous between 2.7 and 2.6", release is None and wider == ["2.7", "2.6"], wider)
ok("'latest' matches nothing", lifecycle.match_cycle("latest", PG) == (None, []))
ok("'99' matches nothing", lifecycle.match_cycle("99", PG) == (None, []))

# ------------------------------------------------------------------ #
print("\nWhat the dates mean on a fixed day")
soon = 365


def status_of(**release) -> dict:
    return lifecycle.assess({"cycle": "x", **release}, TODAY, soon)


ok("end date passed: ended", status_of(eol="2023-11-09")["status"] == "ended")
ok("end date is today: still supported, ending", status_of(eol="2026-09-19")["status"] == "ending")
ok("end date yesterday: ended", status_of(eol="2026-09-18")["status"] == "ended")
ok("end within a year: ending", status_of(eol="2027-03-01")["status"] == "ending")
ok("end exactly a year out: ending", status_of(eol="2027-09-19")["status"] == "ending")
ok("end a year and a day out: supported", status_of(eol="2027-09-20")["status"] == "supported")
ok("no end announced (false): supported", status_of(eol=False)["status"] == "supported")
ended_nodate = status_of(eol=True)
ok("ended with no date (true): ended, and says there is no date",
   ended_nodate["status"] == "ended" and ended_nodate["eolNoDate"] is True
   and ended_nodate["eol"] is None)
ok("active support over, end ahead: security fixes only",
   status_of(eol="2029-01-01", support="2025-01-01")["securityOnly"] is True)
ok("no security-only note once it has ended",
   status_of(eol="2020-01-01", support="2019-01-01")["securityOnly"] is False)
ok("future extended support is reported by date",
   status_of(eol="2023-06-30", extendedSupport="2029-06-30")["extendedSupport"] == "2029-06-30")
ok("past extended support is not reported",
   status_of(eol="2020-01-01", extendedSupport="2021-01-01")["extendedSupport"] is None)
ok("extended support with no date is reported as available",
   status_of(eol="2022-11-12", extendedSupport=True)["extendedSupport"] is True)
ok("an unreadable date is not guessed", status_of(eol="soon")["status"] == "supported"
   and status_of(eol="soon")["eol"] is None)

# ------------------------------------------------------------------ #
print("\nWhether the design's own words state a version")
for quote, version, expected in (
    ("Orders are stored in a PostgreSQL 11 instance.", "11", True),
    ("Spring Boot 2.7.3 services", "2.7", True),
    ("Built on Python v3.11", "v3.11", True),
    ("Runs on Java8 runtime", "8", True),
    ("Java 1.8 across services", "1.8", True),
    ("Held in bucket 211 for PostgreSQL", "11", False),
    ("PostgreSQL in the Toronto region", "11", False),
    ("Node 18.20 on the edge", "18", True),
):
    ok(f"{version!r} in {quote!r}: {expected}", lifecycle._states(quote, version) is expected)

# ------------------------------------------------------------------ #
HEADS = [
    {"ordinal": 1, "title": "Platform", "headingPath": "LCL Portal › Platform",
     "pageStart": 16, "pageEnd": 16},
    {"ordinal": 2, "title": "Data", "headingPath": "LCL Portal › Data",
     "pageStart": 17, "pageEnd": 17},
]
ROWS = [
    {"page": 16, "kind": "text", "sectionOrdinal": 1,
     "text": "Device agnostic & responsive UI through Angular 12 & Bootstrap."},
    {"page": 16, "kind": "text", "sectionOrdinal": 1,
     "text": "Services are built with Spring Boot 2.7.3 on Java 1.8."},
    {"page": 16, "kind": "text", "sectionOrdinal": 1,
     "text": "Messages flow through RabbitMQ between the LCL-OrderHub and billing."},
    {"page": 17, "kind": "text", "sectionOrdinal": 2,
     "text": "Orders are stored in a single PostgreSQL 11 instance in the Toronto region."},
    {"page": 17, "kind": "text", "sectionOrdinal": 2,
     "text": "Nitin Billing Service keeps invoices for seven years."},
]
SECTIONS = coverage.group(HEADS, ROWS)
WHOLE = whole_document.build("LCL Proposal", ROWS, [])
KNOWN = {p.id: p for p in (
    lifecycle.Product("postgresql", "PostgreSQL", ("postgres",)),
    lifecycle.Product("angular", "Angular"),
    lifecycle.Product("spring-boot", "Spring Boot"),
    lifecycle.Product("eclipse-temurin", "Eclipse Temurin"),
    lifecycle.Product("rabbitmq", "RabbitMQ"),
)}


def tech(**fields) -> dict:
    base = {"name": "", "product": "", "version": "", "section": 1, "quote": "", "page": 16}
    base.update(fields)
    return base


REPLY = {
    "technologies": [
        tech(name="Angular", product="angular", version="12",
             quote="Device agnostic & responsive UI through Angular 12 & Bootstrap."),
        tech(name="Spring Boot", product="spring-boot", version="2.7.3",
             quote="Services are built with Spring Boot 2.7.3 on Java 1.8."),
        tech(name="Java", product="eclipse-temurin", version="1.8",
             quote="Services are built with Spring Boot 2.7.3 on Java 1.8."),
        tech(name="PostgreSQL", product="postgresql", version="11", section=2, page=17,
             quote="Orders are stored in a single PostgreSQL 11 instance in the Toronto region."),
        tech(name="RabbitMQ", product="rabbitmq", version="",
             quote="Messages flow through RabbitMQ between the LCL-OrderHub and billing."),
        # The customer's own systems: must never be looked up, whatever id the
        # model gives them.
        tech(name="LCL-OrderHub", product="lcl-orderhub", version="",
             quote="Messages flow through RabbitMQ between the LCL-OrderHub and billing."),
        tech(name="Nitin Billing Service", product="", version="7", section=2, page=17,
             quote="Nitin Billing Service keeps invoices for seven years."),
        # Refused or corrected, one reason each.
        tech(name="Bootstrap", product="", version="5",
             quote="Device agnostic & responsive UI through Angular 12 & Bootstrap."),
        tech(name="Kafka", product="", version="3", quote="Events are streamed through Kafka 3."),
        tech(name="Redis", product="", version="", section=9, quote="Redis caches sessions."),
        tech(name="Angular", product="angular", version="12",
             quote="Device agnostic & responsive UI through Angular 12 & Bootstrap."),
        tech(name="", product="angular", version="12", quote="Angular 12"),
        tech(name="MySQL", product="", version="8", quote=""),
    ]
}

print("\nChecking the model's reading")
checked = lifecycle.check(REPLY, SECTIONS, WHOLE, KNOWN)
names = [t["name"] for t in checked.technologies]
ok("kept the eight the design bears out",
   names == ["Angular", "Spring Boot", "Java", "PostgreSQL", "RabbitMQ", "LCL-OrderHub",
             "Nitin Billing Service", "Bootstrap"], names)
by_name = {t["name"]: t for t in checked.technologies}
ok("an id not on the list is dropped to untracked, never looked up",
   by_name["LCL-OrderHub"]["product"] is None and checked.corrected["unknownProduct"] == 1)
ok("a product the design does not name is not looked up: plain 'Java' is not Eclipse Temurin",
   by_name["Java"]["product"] is None and checked.corrected["unmatchedProduct"] == 1,
   checked.corrected)
ok("a version not in the design's words is not reported on",
   by_name["Nitin Billing Service"]["version"] is None
   and by_name["Bootstrap"]["version"] is None
   and checked.corrected["unstatedVersion"] == 2, checked.corrected)
ok("a quote not in the design throws the technology out",
   "Kafka" not in by_name and checked.dropped["unverified"] == 1, checked.dropped)
ok("an unknown section throws it out", "Redis" not in by_name
   and checked.dropped["unknownSection"] == 1)
ok("the same technology and version twice is kept once", checked.dropped["duplicate"] == 1)
ok("no name, or no quote, is refused",
   checked.dropped["empty"] == 1 and checked.dropped["missingQuote"] == 1, checked.dropped)
ok("a kept one carries its label, quote and page",
   by_name["PostgreSQL"]["label"] == "PostgreSQL" and by_name["PostgreSQL"]["page"] == 17
   and "PostgreSQL 11" in by_name["PostgreSQL"]["quote"])
ANGULAR_LINE = "Device agnostic & responsive UI through Angular 12 & Bootstrap."
dupes = lifecycle.check(
    {"technologies": [
        tech(name="Angular" if n % 2 else "Angular 12", product="angular", version="12",
             quote=ANGULAR_LINE)
        for n in range(10)
    ]},
    SECTIONS, WHOLE, KNOWN,
)
ok("the same product and version under two names is kept once",
   len(dupes.technologies) == 1 and dupes.dropped["duplicate"] == 9, dupes.dropped)
many = lifecycle.check(
    {"technologies": [
        tech(name=f"Tool {n}", quote=ANGULAR_LINE) for n in range(lifecycle.MAX_TECHNOLOGIES + 5)
    ]},
    SECTIONS, WHOLE, KNOWN,
)
ok("over the limit: the first 60 are kept and the rest counted",
   len(many.technologies) == lifecycle.MAX_TECHNOLOGIES and many.dropped["overLimit"] == 5,
   (len(many.technologies), many.dropped["overLimit"]))

# ------------------------------------------------------------------ #
print("\nIs the product the model chose the one the design names?")
P = lifecycle.Product
for name, quote, product, expected in (
    ("Git", "Bit-Bucket, Git, Jenkins", P("gitlab", "GitLab"), False),
    ("SAP Hybris", "SAP Hybris commerce", P("sapmachine", "SapMachine"), False),
    ("Spring Batch Framework", "Spring Batch Framework jobs",
     P("spring-boot", "Spring Boot", ("springboot",)), False),
    ("MySQL", "MySQL | Cloud SQL", P("mssqlserver", "Microsoft SQL Server", ("mssql",)), False),
    ("Java", "Java 1.8 across services", P("eclipse-temurin", "Eclipse Temurin", ("temurin",)), False),
    ("Kafka", "Events flow through RabbitMQ", P("rabbitmq", "RabbitMQ"), False),
    ("Maven", "IntelliJ IDEA, Maven, Junit", P("apache-maven", "Apache Maven"), True),
    ("Bit-Bucket", "Bit-Bucket, Git", P("bitbucket", "Bitbucket", ("atlassian-bitbucket",)), True),
    ("NexusOSS", "Artifacts | NexusOSS", P("nexus", "Nexus Repository"), True),
    ("SonarQube", "Code Quality | SonarQube", P("sonarqube-community", "SonarQube Community Build"), True),
    ("Docker", "Containers | Docker", P("docker-engine", "Docker Engine"), True),
    ("Postgres 14", "Postgres 14 cluster", P("postgresql", "PostgreSQL", ("postgres", "pg")), True),
    ("PG", "PG for reporting", P("postgresql", "PostgreSQL", ("postgres", "pg")), True),
    ("Rabbit MQ", "Rabbit MQ", P("rabbitmq", "RabbitMQ"), True),
    ("Node.js 18", "Runs on Node.js 18", P("nodejs", "Node.js", ("node",)), True),
):
    ok(f"{name!r} is {product.id}: {expected}",
       lifecycle._names_product(name, quote, product) is expected)

# ------------------------------------------------------------------ #
print("\nNames in tables and lists, where a quote is too short to check")
T_HEADS = [
    {"ordinal": 1, "title": "Tools", "headingPath": "Portal › Tools", "pageStart": 5, "pageEnd": 5},
    {"ordinal": 2, "title": "Cloud", "headingPath": "Portal › Cloud", "pageStart": 6, "pageEnd": 6},
]
T_ROWS = [
    {"page": 5, "kind": "text", "sectionOrdinal": 1, "text": "Security | Harbor"},
    {"page": 5, "kind": "text", "sectionOrdinal": 1, "text": "Deployment tooling is chosen later."},
    {"page": 6, "kind": "text", "sectionOrdinal": 2, "text": "Storage | Cloud Storage"},
]
T_SECTIONS = coverage.group(T_HEADS, T_ROWS)
T_WHOLE = whole_document.build("Portal", T_ROWS, [])
table_reading = lifecycle.check(
    {"technologies": [
        tech(name="Harbor", product="harbor", section=1, page=5, quote="Security | Harbor"),
        tech(name="Cloud Storage", section=1, page=5, quote="Storage | Cloud Storage"),
        tech(name="Spinnaker", section=1, page=5, quote="Deployment | Spinnaker"),
    ]},
    T_SECTIONS,
    T_WHOLE,
    {"harbor": P("harbor", "Harbor")},
)
tabled = {t["name"]: t for t in table_reading.technologies}
ok("a name in a table cell is kept, quoted by its own line",
   "Harbor" in tabled and tabled["Harbor"]["quote"] == "Security | Harbor"
   and tabled["Harbor"]["product"] == "harbor", tabled.get("Harbor"))
ok("a name placed in the wrong section moves to the one that has it",
   "Cloud Storage" in tabled and tabled["Cloud Storage"]["section"] == 2
   and tabled["Cloud Storage"]["page"] == 6, tabled.get("Cloud Storage"))
ok("a name the design does not contain anywhere is dropped",
   "Spinnaker" not in tabled and table_reading.dropped["unverified"] == 1, table_reading.dropped)
ok("and the replacements are counted", table_reading.corrected["lineQuote"] == 2,
   table_reading.corrected)

# ------------------------------------------------------------------ #
print("\nA run end to end, with the model and the database stubbed")
stored: list[tuple] = []


@contextlib.contextmanager
def fake_connection():
    yield object()


def fake_execute(conn, sql, params=None):
    stored.append((sql, params))
    return 1


model_calls: list[dict] = []


def fake_find(*, design, products, title):
    model_calls.append({"design": design, "products": products, "title": title})
    return REPLY


real = {
    "connection": db.connection,
    "execute": db.execute,
    "load": coverage._load,
    "available": llm.available,
    "find": llm.find_technologies,
    "model_name": llm.model_name,
    "get_config": lifecycle.get_config,
}
db.connection = fake_connection
db.execute = fake_execute
coverage._load = lambda conn, document_id: (SECTIONS, WHOLE)
llm.available = lambda: True
llm.find_technologies = fake_find
llm.model_name = lambda: ("openrouter", "openai/gpt-4.1-mini")
base_config = real["get_config"]()
lifecycle.get_config = lambda: base_config
RUN = {"id": "run-1", "documentId": "doc-1"}

try:
    fresh_fetches()
    result = lifecycle.work_out(RUN, today=TODAY)
    techs = {t["name"]: t for t in result["technologies"]}
    ok("complete", result["state"] == "complete", result.get("note"))
    ok("the model saw the design, the product list and the title",
       model_calls and "PostgreSQL 11" in model_calls[0]["design"]
       and "postgresql — PostgreSQL (also: postgres, pg)" in model_calls[0]["products"]
       and model_calls[0]["title"] == "LCL Proposal")
    ok("an id that is not a plain slug never reaches the list",
       "Bad Id!" not in model_calls[0]["products"])

    print("\n  statuses")
    ok("PostgreSQL 11: ended 9 Nov 2023, move to 18",
       techs["PostgreSQL"]["status"] == "ended" and techs["PostgreSQL"]["eol"] == "2023-11-09"
       and techs["PostgreSQL"]["cycle"] == "11" and techs["PostgreSQL"]["latest"] == "11.22"
       and techs["PostgreSQL"]["upgradeTo"] == "18", techs["PostgreSQL"])
    ok("Angular 12: ended, paid extended support available, move to the LTS line 20",
       techs["Angular"]["status"] == "ended" and techs["Angular"]["extendedSupport"] is True
       and techs["Angular"]["upgradeTo"] == "20", techs["Angular"])
    ok("Spring Boot 2.7.3: line 2.7, ended, extended support until 2029",
       techs["Spring Boot"]["cycle"] == "2.7" and techs["Spring Boot"]["status"] == "ended"
       and techs["Spring Boot"]["extendedSupport"] == "2029-06-30", techs["Spring Boot"])
    ok("plain 'Java 1.8' is not guessed onto one vendor's JDK: untracked, never looked up",
       techs["Java"]["status"] == "untracked" and techs["Java"]["product"] is None, techs["Java"])
    ok("RabbitMQ with no version: unchecked (no data in the fake), not guessed",
       techs["RabbitMQ"]["status"] in ("unchecked", "unversioned"), techs["RabbitMQ"]["status"])
    ok("the customer's own systems: untracked",
       techs["LCL-OrderHub"]["status"] == "untracked"
       and techs["Nitin Billing Service"]["status"] == "untracked")
    order = [t["status"] for t in result["technologies"]]
    ok("ordered with what needs acting on first",
       order == sorted(order, key=lifecycle.STATUSES.index), order)

    print("\n  what left the system")
    paths = [url.split("/api/", 1)[1] for url in requested]
    allowed = {"v1/products"} | {f"{pid}.json" for pid in KNOWN}
    ok("only the product list and product ids were asked for",
       set(paths) <= allowed, paths)
    ok("each product asked for once", len(paths) == len(set(paths)), paths)
    leaked = [
        word for word in ("LCL", "Nitin", "OrderHub", "Toronto", "Proposal", "11", "2.7", "1.8",
                          "orderhub", "billing", "invoices")
        if any(word in url for url in requested)
    ]
    ok("no word from the design, its title, a customer system or a version in any URL",
       not leaked, (leaked, requested))
    ok("the customer's own names were never looked up",
       not any("lcl" in url.lower() or "nitin" in url.lower() for url in requested))

    print("\n  RabbitMQ has no release data in the fake: a 404 is 'not checked'")
    ok("a product whose lookup fails is reported as not checked",
       techs["RabbitMQ"]["status"] == "unchecked", techs["RabbitMQ"]["status"])

    print("\n  public data is held for a day")
    before = len(requested)
    lifecycle.work_out(RUN, today=TODAY)
    ok("a second run asks for nothing again", len(requested) == before, requested[before:])
    real_monotonic = lifecycle.time.monotonic
    lifecycle.time.monotonic = lambda: real_monotonic() + lifecycle.HOLD_SECONDS + 1
    try:
        lifecycle.work_out(RUN, today=TODAY)
    finally:
        lifecycle.time.monotonic = real_monotonic
    ok("after a day it asks again", len(requested) > before)

    print("\n  one product timing out does not sink the rest")
    fresh_fetches()
    broken.add("postgresql.json")
    partial = {t["name"]: t for t in lifecycle.work_out(RUN, today=TODAY)["technologies"]}
    ok("that one is not checked", partial["PostgreSQL"]["status"] == "unchecked")
    ok("the others still are", partial["Angular"]["status"] == "ended")
    broken.clear()
    before = len(requested)
    retried = {t["name"]: t for t in lifecycle.work_out(RUN, today=TODAY)["technologies"]}
    ok("a timeout is not remembered: the next run asks again, and gets it",
       "https://endoflife.date/api/postgresql.json" in requested[before:]
       and retried["PostgreSQL"]["status"] == "ended", requested[before:])
    ok("while a 404 is remembered for the day",
       "https://endoflife.date/api/rabbitmq.json" not in requested[before:])

    print("\n  failures and switches")
    fresh_fetches()
    broken.add("v1/products")
    model_calls.clear()
    down = lifecycle.record(RUN)
    ok("endoflife.date unreachable: failed, says so, and the model is never asked",
       down["state"] == "failed" and "endoflife.date could not be reached" in down["note"]
       and not model_calls, down.get("note"))
    ok("and it is still stored", stored and stored[-1][1][0].obj["state"] == "failed")

    fresh_fetches()

    def quota(**_):
        raise llm.QuotaExhausted("credits")

    llm.find_technologies = quota
    spent = lifecycle.record(RUN)
    ok("model out of credits: failed with that reason",
       spent["state"] == "failed" and "credits or quota" in spent["note"])
    llm.find_technologies = fake_find

    fresh_fetches()
    lifecycle.get_config = lambda: dataclasses.replace(base_config, lifecycle_check=False)
    off = lifecycle.record(RUN)
    ok("switched off: skipped, says how, and nothing is fetched",
       off["state"] == "skipped" and "LIFECYCLE_CHECK" in off["note"] and not requested)
    lifecycle.get_config = lambda: base_config

    llm.available = lambda: False
    nokey = lifecycle.record(RUN)
    ok("no model key: skipped", nokey["state"] == "skipped" and "API key" in nokey["note"])
    llm.available = lambda: True

    coverage._load = lambda conn, document_id: ([], None)
    unparsed = lifecycle.record(RUN)
    ok("no stored pages: skipped, says to reprocess",
       unparsed["state"] == "skipped" and "Reprocess" in unparsed["note"])
    coverage._load = lambda conn, document_id: (SECTIONS, WHOLE)

    print("\n  stored on the run")
    fresh_fetches()
    stored.clear()
    good = lifecycle.record(RUN)
    ok("written to the run's lifecycle column",
       stored and 'SET "lifecycle"' in stored[-1][0] and stored[-1][1][1] == "run-1"
       and stored[-1][1][0].obj["state"] == "complete")
    ok("says where the dates came from and when",
       good["source"] == "endoflife.date" and bool(good["checkedAt"]) and good["soonDays"] == 365)

    def no_column(conn, sql, params=None):
        raise RuntimeError('column "lifecycle" does not exist')

    db.execute = no_column
    ok("an unmigrated database does not raise", lifecycle.record(RUN)["state"] == "complete")
finally:
    db.connection = real["connection"]
    db.execute = real["execute"]
    coverage._load = real["load"]
    llm.available = real["available"]
    llm.find_technologies = real["find"]
    llm.model_name = real["model_name"]
    lifecycle.get_config = real["get_config"]

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
