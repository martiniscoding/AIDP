"""Whether the technologies a design names are still supported.

A design built on PostgreSQL 11 or Angular 12 is built on software whose support
has already ended, and that is often the most consequential thing a reviewer can
say about it. The model cannot say it: it has no internet access, and the
suggestions prompt forbids it to claim a version is out of support, because its
training is older than the question. So this answers it from public data, and the
report states it as a fact with a source and a date rather than as a model's
guess.

How it works, and what leaves this system
-----------------------------------------
1. **The model names the technologies, offline.** It reads the design — as the
   suggestions do — beside endoflife.date's list of products, and gives back each
   technology the design uses, the product id it is on that list, the version the
   design states and the design's own words. Nothing is looked up at this point.
2. **Code checks the reply.** A product id must be one of endoflife.date's own;
   anything else — an internal system, a product the list does not carry — is
   kept for the report but never looked up, so no name of the customer's own ever
   leaves. The quote must be the design's words, inside the section named
   (coverage.py's check), and a version counts only if it is in that quote: a
   version the design does not state is not one to report on.
3. **Only product ids go out.** One request per product for all of its release
   lines (`GET /api/postgresql.json`); the version is matched against them here.
   The design's text, its title, the customer's name and even the version stay
   in this system. Every request is logged by path, so what was sent can be
   audited.
4. **Status is worked out on the day.** Support ended, support ending within
   LIFECYCLE_SOON_DAYS, supported, or a version the design does not state — with
   the latest patch in the line and the release to move to.

The reading in step 1 is reused for an unchanged design, as the suggested
improvements are (cache kind "lifecycle"): the same design lists the same
technologies. The lookups and statuses are redone every run, since the dates are
the point. Public data is held in memory for a day, so one product is not asked
for twice in a run, or in a day.

Stored on the run as JSON (`assessment_run.lifecycle`, read by the app's
src/lib/ingest/lifecycle.ts). It never fails a run.
"""

from __future__ import annotations

import datetime as dt
import re
import threading
import time
from dataclasses import dataclass, field

import httpx
from psycopg.types.json import Jsonb

from . import cache, coverage, db, logs, usage, whole_document
from .ai import llm
from .config import get_config
from .coverage import _checked_quote, _clean, _integer

log = logs.get(__name__)

VERSION = 1
SOURCE = "endoflife.date"

# Kept from one reading. A design naming more than this is a catalogue, and the
# report would bury the three that matter.
MAX_TECHNOLOGIES = 60

TIMEOUT_SECONDS = 10.0

# Public data changes a few times a day at most and is the same for everyone.
HOLD_SECONDS = 24 * 3600

# The design rendered uncut for the cache key, as advice.py does.
_UNCUT = 10**12

# The only shape a product id may take before it is put into a URL. The list is
# endoflife.date's own, but a URL built from data is checked, not trusted.
_SLUG = re.compile(r"[a-z0-9][a-z0-9._+-]*")

_NUMBER = re.compile(r"\d+(?:\.\d+)*")

# The report's order: what needs acting on first.
STATUSES = (
    "ended",
    "ending",
    "unchecked",
    "unknownVersion",
    "unversioned",
    "supported",
    "untracked",
)


class NotFound(Exception):
    """endoflife.date has no such path."""


class Unreachable(Exception):
    """endoflife.date's product list could not be read, so nothing can be checked."""


@dataclass(frozen=True)
class Product:
    id: str
    label: str
    aliases: tuple[str, ...] = ()


@dataclass
class Checked:
    technologies: list[dict] = field(default_factory=list)
    dropped: dict[str, int] = field(
        default_factory=lambda: {
            "empty": 0,
            "unknownSection": 0,
            "missingQuote": 0,
            "unverified": 0,
            "outsideSection": 0,
            "duplicate": 0,
            "overLimit": 0,
        }
    )
    # Kept, but corrected: an id not on the list, or one whose product the design
    # does not name, is never looked up; a version not in the design's words is
    # not reported on; a quote too short to verify is replaced by the design's
    # own line naming the technology.
    corrected: dict[str, int] = field(
        default_factory=lambda: {
            "unknownProduct": 0,
            "unmatchedProduct": 0,
            "unstatedVersion": 0,
            "lineQuote": 0,
        }
    )


# ------------------------------------------------------------------ #
# endoflife.date — the one place this module reaches the internet
# ------------------------------------------------------------------ #

_held: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()

# A 404 is an answer too, and held like one: asking again within the day would
# get the same. A timeout or a 5xx is not held, so the next run tries again.
_MISSING = object()


def _fetch(path: str) -> object:
    """GET one endoflife.date API path as JSON, held in memory for a day.

    `path` is only ever the product list or `<product id>.json` for an id taken
    from that list; see `releases`. Logged, so what was sent can be audited.
    """
    now = time.monotonic()
    with _lock:
        held = _held.get(path)
        if held is not None and now - held[0] < HOLD_SECONDS:
            if held[1] is _MISSING:
                raise NotFound(path)
            return held[1]

    base = get_config().lifecycle_base_url.rstrip("/")
    logs.info(log, "lifecycle lookup", path=path)
    response = httpx.get(
        f"{base}/{path}",
        timeout=TIMEOUT_SECONDS,
        follow_redirects=True,
        headers={"Accept": "application/json", "User-Agent": "aidp-lifecycle-check"},
    )
    if response.status_code == 404:
        with _lock:
            _held[path] = (now, _MISSING)
        raise NotFound(path)
    response.raise_for_status()
    data = response.json()
    with _lock:
        _held[path] = (now, data)
    return data


def products() -> dict[str, Product]:
    """Every product endoflife.date tracks, by id. The allowlist for lookups."""
    data = _fetch("v1/products")
    items = data.get("result") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError("endoflife.date returned no product list")
    out: dict[str, Product] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        product_id = str(item.get("name") or "").strip()
        if not _SLUG.fullmatch(product_id):
            continue
        aliases = tuple(
            alias for alias in (item.get("aliases") or []) if isinstance(alias, str) and alias
        )
        out[product_id] = Product(product_id, str(item.get("label") or product_id), aliases)
    return out


def releases(product_id: str) -> list[dict]:
    """A product's release lines, newest first, as endoflife.date lists them."""
    if not _SLUG.fullmatch(product_id):
        raise ValueError(f"not a product id: {product_id!r}")
    data = _fetch(f"{product_id}.json")
    if not isinstance(data, list):
        raise RuntimeError(f"endoflife.date returned no release lines for {product_id}")
    return [row for row in data if isinstance(row, dict) and row.get("cycle") is not None]


def render_products(known: dict[str, Product]) -> str:
    """The list the model chooses ids from: "id — name (also: aliases)"."""
    lines = []
    for product in sorted(known.values(), key=lambda p: p.id):
        also = f" (also: {', '.join(product.aliases)})" if product.aliases else ""
        lines.append(f"{product.id} — {product.label}{also}")
    return "\n".join(lines)


# ------------------------------------------------------------------ #
# Matching a stated version, and what its dates mean today
# ------------------------------------------------------------------ #


def match_cycle(version: str, cycles: list[dict]) -> tuple[dict | None, list[str]]:
    """The release line a stated version belongs to. (line, ambiguous lines)

    "11.4" is in line "11", "2.7.18" in "2.7"; the most specific line wins. Java's
    old numbering is tried as well — "1.8" is line "8". A version that is less
    specific than the lines ("2" when there are "2.6" and "2.7") belongs to none
    of them, and the lines it could be are returned so the report can say so.
    """
    found = _NUMBER.search(version or "")
    if not found:
        return None, []
    wanted = found.group(0)
    tries = [wanted]
    if wanted.startswith("1.") and len(wanted) > 2:
        tries.append(wanted[2:])

    for candidate in tries:
        best: dict | None = None
        for release in cycles:
            cycle = str(release.get("cycle"))
            if candidate == cycle or candidate.startswith(cycle + "."):
                if best is None or len(cycle) > len(str(best.get("cycle"))):
                    best = release
        if best is not None:
            return best, []

    wider = [
        str(release.get("cycle"))
        for release in cycles
        if str(release.get("cycle")).startswith(wanted + ".")
    ]
    return None, wider


def _as_date(value) -> dt.date | None:
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def assess(release: dict, today: dt.date, soon_days: int) -> dict:
    """What one release line's dates mean on `today`.

    `eol` is a date, or True for "ended, no date given", or False for "no end
    announced". The end date itself is still supported; the day after is not.
    """
    eol = release.get("eol")
    eol_date = _as_date(eol)
    if eol is True or (eol_date is not None and eol_date < today):
        status = "ended"
    elif eol_date is not None and eol_date <= today + dt.timedelta(days=soon_days):
        status = "ending"
    else:
        status = "supported"

    support = _as_date(release.get("support"))
    extended = release.get("extendedSupport")
    extended_date = _as_date(extended)
    return {
        "status": status,
        "eol": eol_date.isoformat() if eol_date else None,
        "eolNoDate": eol is True,
        "support": support.isoformat() if support else None,
        # Past active support but not past the end: security fixes only.
        "securityOnly": status != "ended" and support is not None and support < today,
        "extendedSupport": (
            extended_date.isoformat()
            if extended_date and extended_date >= today
            else True
            if extended is True
            else None
        ),
        "lts": bool(release.get("lts")),
        "latest": str(release["latest"]) if release.get("latest") else None,
    }


def _move_to(cycles: list[dict]) -> str | None:
    """The line to upgrade to: the newest long-term line if the product has them."""
    if not cycles:
        return None
    lts = next((release for release in cycles if release.get("lts")), None)
    return str((lts or cycles[0]).get("cycle"))


# ------------------------------------------------------------------ #
# Checking the model's reading
# ------------------------------------------------------------------ #


def _states(quote: str, version: str) -> bool:
    """Whether the design's own words state this version."""
    found = _NUMBER.search(version)
    core = found.group(0) if found else version.strip()
    if not core:
        return False
    # Only digits count as a neighbour: "v3.11" and "Java8" state their versions,
    # "211" does not state 11. A trailing ".3" or "u292" is the same version, more
    # precisely.
    return re.search(r"(?<![\d.])" + re.escape(core) + r"(?!\d)", quote, re.IGNORECASE) is not None


def _key(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold()))


def _compact(value: str) -> str:
    """Letters and digits only: "Bit-Bucket", "Rabbit MQ", "Node.js" → bitbucket, rabbitmq, nodejs."""
    return re.sub(r"[^a-z0-9]", "", value.casefold())


# Words in a product's name that say who makes it or which flavour it is, not
# what it is. "Apache Maven" is named by "Maven", "SonarQube Community Build" by
# "SonarQube", "Docker Engine" by "Docker".
_GENERIC = {
    "apache", "eclipse", "oracle", "microsoft", "amazon", "aws", "google", "ibm",
    "redhat", "red", "hat", "community", "build", "engine", "repository", "server",
    "edition", "enterprise", "the", "for", "and",
}


def _names_product(name: str, quote: str, product: Product) -> bool:
    """Whether the design's name for a technology is this product.

    The model is told never to pick a merely similar product, and on real designs
    still maps "Git" to GitLab and "SAP Hybris" to SapMachine — each of which would
    put another product's dates on the report. So the choice is checked: the name
    must be the design's own words, and must contain the product's id, its name
    without maker or flavour words, or one of its aliases. Short ones ("pg",
    "sql", "k8s") must be the whole name, so "MySQL" never reads as SQL Server.
    """
    named = _compact(name)
    if not named or named not in _compact(quote):
        return False
    bare = re.sub(r"\d+$", "", named)  # "postgres14" names "postgres"
    words = [w for w in re.findall(r"[a-z0-9]+", product.label.casefold()) if w not in _GENERIC]
    candidates = {_compact(product.id), _compact(product.label), "".join(words)}
    candidates |= {_compact(alias) for alias in product.aliases}
    for candidate in candidates:
        if not candidate:
            continue
        if len(candidate) >= 5:
            if candidate in named:
                return True
        elif candidate in (named, bare):
            return True
    return False


def _line_naming(
    sections: list[coverage.Section], section: coverage.Section, name: str
) -> tuple[coverage.Section | None, str | None]:
    """The design's own line naming a technology, when the model's quote cannot be checked.

    Technology names live in table cells and bullet lists — "Rabbit MQ",
    "Security | Harbor" — which the quote check refuses as too short to be
    evidence of anything. For a name, the line it stands on is the evidence. The
    named section is searched first; failing that, the one other section that
    names it. Named in several others, it cannot be placed.
    """
    words = name.split()
    if not words:
        return None, None
    pattern = re.compile(
        r"(?<!\w)" + r"\s*".join(re.escape(word) for word in words) + r"(?!\w)", re.IGNORECASE
    )

    def first(candidate: coverage.Section) -> str | None:
        for line in candidate.lines:
            text = re.sub(r"^(## |- )", "", line)
            if pattern.search(text):
                return text
        return None

    line = first(section)
    if line is not None:
        return section, line
    homes = [(other, found) for other in sections if other is not section and (found := first(other))]
    return homes[0] if len(homes) == 1 else (None, None)


def check(
    raw: dict,
    sections: list[coverage.Section],
    whole: whole_document.WholeDocument,
    known: dict[str, Product],
) -> Checked:
    """Keep the technologies the design bears out; count and correct the rest."""
    by_ordinal = {section.ordinal: section for section in sections}
    out = Checked()
    seen: set[tuple[str, str]] = set()
    kept: list[dict] = []

    items = raw.get("technologies") if isinstance(raw.get("technologies"), list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = _clean(item.get("name"), 120)
        if not name:
            out.dropped["empty"] += 1
            continue
        ordinal = _integer(item.get("section"))
        section = by_ordinal.get(ordinal) if ordinal is not None else None
        if section is None:
            out.dropped["unknownSection"] += 1
            continue
        if not " ".join(str(item.get("quote") or "").split()):
            out.dropped["missingQuote"] += 1
            continue
        quote, page, reason = _checked_quote(item, section, whole)
        if quote is None:
            home, line = _line_naming(sections, section, name)
            if home is None or line is None:
                out.dropped[reason] += 1
                continue
            named_page = _integer(item.get("page"))
            section, quote = home, line
            page = (
                named_page
                if named_page in home.pages
                else min(home.pages)
                if home.pages
                else home.page_start
            )
            out.corrected["lineQuote"] += 1

        product = str(item.get("product") or "").strip().lower()
        if product and product not in known:
            # Never looked up: an id the list does not have could be anything,
            # including a name of the customer's own.
            out.corrected["unknownProduct"] += 1
            product = ""
        elif product and not _names_product(name, quote, known[product]):
            # A similar product is a different product with different dates.
            out.corrected["unmatchedProduct"] += 1
            product = ""
        version = _clean(item.get("version"), 60)
        if version and not _states(quote, version):
            out.corrected["unstatedVersion"] += 1
            version = ""

        identity = (product or _key(name), version.casefold())
        if identity in seen:
            out.dropped["duplicate"] += 1
            continue
        seen.add(identity)

        pages = sorted(section.pages)
        kept.append(
            {
                "name": name,
                "product": product or None,
                "label": known[product].label if product else name,
                "version": version or None,
                "section": section.ordinal,
                "sectionTitle": section.title[:300],
                "headingPath": section.heading_path[:1000],
                "pageStart": pages[0] if pages else section.page_start,
                "quote": quote[:1000],
                "page": page,
            }
        )

    out.technologies = kept[:MAX_TECHNOLOGIES]
    out.dropped["overLimit"] = max(0, len(kept) - MAX_TECHNOLOGIES)
    return out


def _status(technology: dict, today: dt.date, soon_days: int) -> dict:
    """One technology with its support status, looked up by product id alone."""
    base = {
        **technology,
        "cycle": None,
        "eol": None,
        "eolNoDate": False,
        "support": None,
        "securityOnly": False,
        "extendedSupport": None,
        "lts": False,
        "latest": None,
        "current": None,
        "upgradeTo": None,
        "ambiguous": [],
    }
    product = technology.get("product")
    if not product:
        return {**base, "status": "untracked"}
    try:
        cycles = releases(product)
    except Exception as exc:  # noqa: BLE001 — one product's lookup failing is that product's problem
        logs.warn(log, "lifecycle lookup failed", product=product, error=str(exc)[:200])
        return {**base, "status": "unchecked"}

    current = str(cycles[0].get("cycle")) if cycles else None
    base["current"] = current
    if not technology.get("version"):
        return {**base, "status": "unversioned"}

    release, ambiguous = match_cycle(technology["version"], cycles)
    if release is None:
        return {**base, "status": "unknownVersion", "ambiguous": ambiguous[:8]}

    facts = assess(release, today, soon_days)
    cycle = str(release.get("cycle"))
    move = _move_to(cycles) if facts["status"] in ("ended", "ending") else None
    return {
        **base,
        **facts,
        "cycle": cycle,
        "upgradeTo": move if move and move != cycle else None,
    }


# ------------------------------------------------------------------ #
# The run
# ------------------------------------------------------------------ #


def _outcome(state: str, note: str | None, **rest) -> dict:
    cfg = get_config()
    return {
        "version": VERSION,
        "state": state,
        "note": note,
        "checkedAt": db.now().isoformat(),
        "source": SOURCE,
        "soonDays": cfg.lifecycle_soon_days,
        "model": llm.model_name()[1],
        "technologies": rest.get("technologies", []),
        "dropped": rest.get("dropped", {}),
        "corrected": rest.get("corrected", {}),
        "truncated": rest.get("truncated", False),
        # When and how the design was read for its technologies. The statuses
        # themselves are always from today's lookup.
        "extraction": rest.get("extraction"),
    }


def work_out(run: dict, *, today: dt.date | None = None) -> dict:
    """The support status of every technology the run's design names.

    Raises when the model or endoflife.date's product list cannot be reached;
    `record` turns that into a stated reason. One product failing to look up is
    not a failure: that technology is reported as not checked.
    """
    cfg = get_config()
    if not cfg.lifecycle_check:
        return _outcome(
            "skipped",
            "The technology support check is turned off in this deployment (LIFECYCLE_CHECK=off).",
        )

    with db.connection() as conn:
        sections, whole = coverage._load(conn, run["documentId"])
    if whole is None or not sections:
        return _outcome(
            "skipped",
            "This design was processed before its pages were stored, so the technologies it "
            "uses could not be read. Reprocess it, then run the assessment again.",
        )
    if not llm.available():
        return _outcome(
            "skipped",
            "No model API key is configured, so the technologies in this design could not be read.",
        )

    try:
        known = products()
    except Exception as exc:  # noqa: BLE001 — reported by `record`
        raise Unreachable(str(exc)) from exc
    listing = render_products(known)

    budget = max(
        20_000,
        cfg.whole_document_max_tokens * whole_document.CHARS_PER_TOKEN - len(listing),
    )
    design, shortened = coverage.render_design(sections, budget)

    organisation = run.get("organisationId")
    provider, model = llm.model_name()
    key: str | None = None
    if cfg.advice_cache_days > 0 and organisation:
        key = cache.lifecycle_key(
            design=coverage.render_design(sections, _UNCUT)[0],
            title=whole.title,
            products=listing,
            provider=provider,
            model=model,
            prompt=llm.lifecycle_prompt_identity(),
            version=VERSION,
        )
    stored = (
        cache.get_payload(organisation, cache.LIFECYCLE, key, max_age_days=cfg.advice_cache_days)
        if key
        else None
    )
    reply = stored.payload.get("raw") if stored else None
    if isinstance(reply, dict):
        raw = reply
        extraction = {"source": "cache", "generatedAt": stored.created_at.isoformat()}
    else:
        raw = llm.find_technologies(design=design, products=listing, title=whole.title)
        now = db.now()
        read_at = now.replace(microsecond=now.microsecond // 1000 * 1000)
        extraction = {"source": "model", "generatedAt": read_at.isoformat()}
        if key:
            cache.put_payload(
                organisation,
                cache.LIFECYCLE,
                key,
                model=model,
                payload={"raw": raw},
                cost_tokens=usage.estimate_tokens(design + listing),
                created_at=read_at,
            )

    checked = check(raw, sections, whole, known)
    on = today or db.now().date()
    technologies = [_status(t, on, cfg.lifecycle_soon_days) for t in checked.technologies]
    technologies.sort(key=lambda t: (STATUSES.index(t["status"]), t["label"].casefold()))

    logs.info(
        log,
        "technology support checked",
        runId=run["id"],
        technologies=len(technologies),
        looked_up=sum(1 for t in technologies if t["product"]),
        ended=sum(1 for t in technologies if t["status"] == "ended"),
        ending=sum(1 for t in technologies if t["status"] == "ending"),
        extraction=extraction["source"],
    )
    return _outcome(
        "complete",
        None,
        technologies=technologies,
        dropped=checked.dropped,
        corrected=checked.corrected,
        truncated=shortened,
        extraction=extraction,
    )


def record(run: dict) -> dict:
    """Check and store the design's technology support. Never raises."""
    try:
        result = work_out(run)
    except Exception as exc:  # noqa: BLE001 — a run's verdicts stand without this
        logs.warn(log, "technology support not checked", runId=run["id"], error=str(exc)[:300])
        if isinstance(exc, Unreachable):
            why = f"{SOURCE} could not be reached"
        elif isinstance(exc, llm.QuotaExhausted):
            why = "the model provider's credits or quota are used up"
        else:
            why = "the model could not be reached or did not answer usably"
        result = _outcome(
            "failed",
            f"The support status of this design's technologies could not be checked: {why}. "
            "Run the assessment again to retry.",
        )
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                'UPDATE "assessment_run" SET "lifecycle" = %s WHERE "id" = %s',
                (Jsonb(result), run["id"]),
            )
    except Exception as exc:  # noqa: BLE001 — e.g. the column not migrated yet
        logs.warn(log, "technology support not recorded", runId=run["id"], error=str(exc)[:300])
    return result
