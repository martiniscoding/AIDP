# How Dexter chunks a standards document

Written to be explainable to a client. Every figure quoted here is measured from
the working system, not estimated.

---

## The problem this solves

Before a document can be searched by an AI system, it has to be cut into pieces.
Each piece is stored, turned into a set of numbers representing its meaning, and
retrieved later when it looks relevant to a question.

The universal way to do this is to cut every N characters — say every 500, with a
little overlap so nothing falls exactly on a seam. It is fast, it works on
anything, and for a standards document it is close to the worst thing you can do.

Here is why. A rule in a standards document looks like this:

> **Least privilege.** Users receive only the access their role requires.
> Access must be requested, approved, and periodically re-certified.

Cut that at 500 characters and you may end up with one piece holding *"Access
must be requested, approved, and periodically re-certified"* and another holding
the title it belongs to. The first piece is now unusable: re-certified **what**?
Requested **by whom**, under **which** principle? A search engine will still
retrieve it, an AI will still reason over it, and the answer will be wrong in a
way nobody can see — because the text it quotes is real, it is just missing the
half that gave it meaning.

In a compliance tool that is not a cosmetic problem. It is the difference between
"this design breaches your access policy" and a sentence that means nothing.

---

## The principle

**Dexter does not decide where to cut. The document already decided.**

A standards document is not a wall of text. It has a structure its authors
created deliberately — numbered sections, headings, a table of contents. That
structure *is* the map of where one rule ends and the next begins.

So there is no character counter, no overlap window, no "semantic breakpoint"
detection. There is no algorithm guessing where a rule probably ends. We read the
structure the author wrote and cut along it.

This has a consequence worth stating plainly, because it is the thing clients
care about:

> **A rule is never divided.** The statement, the reasoning behind it, and every
> requirement it carries are stored together as one indivisible unit. If a rule
> is long, its unit is long. It is never trimmed to fit a size limit.

---

## Step one: finding the boundaries

Boundaries come from headings, so the first job is deciding which lines are
headings and which are ordinary text.

A line is promoted to a heading only when **two independent signals agree**:

1. **Typography** — its font, size and weight match one of the heading levels
   detected in this specific document. The document is profiled first, so we use
   *its* conventions rather than assumptions about what a heading looks like.
2. **Shape** — it either carries a section number (`3.2`, `4.1.1`) or reads like
   a title rather than a sentence.

Requiring both matters. A bold phrase in the middle of a paragraph has heading
*typography* but not heading *shape*, so it is not promoted — otherwise it would
cut a rule in half. A short numbered line in body text has the shape but not the
typography, so it is not promoted either.

A section then runs from one heading to the next. **That is the only boundary
detection in the entire system.**

As a cross-check, the document's own table of contents is parsed separately and
reconciled against the sections found in the body. An entry listed in the
contents with no matching section in the body is raised for human review rather
than passed over.

---

## Step two: what each section becomes

Each section is examined and produces one or more units, depending on what it
actually contains.

### The rule unit

If the section states a rule, the **whole rule** becomes one unit: its statement,
its rationale, every requirement bullet, and any technology guidance — together,
in the order the document presents them.

Finding the rule inside the section is done in three passes, tried in order:

| Pass | Looks for | Used when |
|---|---|---|
| 1. Labelled | Explicit `Statement:` / `Rationale:` / `Requirements:` headings | The document labels its own parts |
| 2. Tabular | A principle grid — name, statement, implications — one row per rule | Rules are laid out as a table |
| 3. Prose | Sentences carrying an obligation: *must*, *shall*, *is required to*, prohibitions | Neither of the above matches |

Pass 3 is what makes the system work on documents written in a house style we
have never seen. It keys on the language of obligation rather than on layout, so
a standard written as ordinary numbered prose is handled without configuration.

It deliberately ignores *should* and *may*, which are advisory in standards
writing. Turning advice into a requirement would be as damaging as missing one.

A rule found by pass 3 is marked as **inferred** in the review queue, so a
reviewer weighing a finding knows it was read out of prose rather than parsed
from labelled structure.

### Table units

A table produces one unit **per row**, with the column headers bound into each
row so it can be read alone, plus one further unit for the table as a whole.

Empty cells are written out as `not specified` rather than omitted. This is
deliberate: an omitted cell is invisible to search, and a model reading a row
with a gap in it will tend to fill the gap from the neighbouring row.

### Figure units

Diagrams are read by a vision model and their description becomes a unit, so an
architecture drawn rather than written is still searchable.

Two safeguards apply. A description a reviewer has **rejected** is not indexed at
all — an incorrect description is worse than none, because it reads like a
quotation from the document. And a description can never decide a compliance
verdict on its own; it can support one, but the diagram is displayed beside the
finding so a person can check the reading.

### Prose units

A section's own narrative text becomes a unit under either of two conditions:

- **320 characters or more**, when the section also has a rule, table or figure.
  Below that it would be a near-duplicate of its own rule, adding noise.
- **60 characters or more**, when the section has nothing else. Here the prose is
  the only record of that content anywhere. Dropping it would make the section
  invisible to search, and an assessment would then report a requirement as
  "absent" when the document plainly addresses it.

---

## What every unit carries

Each unit is stored as three parts, so it can be understood by whoever — or
whatever — retrieves it, without needing its neighbours:

1. **Its location** — the full heading path, e.g.
   `Security Standards › 3 Network Security › 3.2 Secure Remote Access`
2. **A one-line summary**, generated when the unit is created, describing what it
   is and where it sits in the document.
3. **The content itself.**

It is then converted into a vector — a numerical representation of its meaning —
and stored alongside a conventional full-text index.

---

## What this produces in practice

From one 7-page security standard:

| Unit type | Count |
|---|---|
| Table rows | 18 |
| Section prose | 16 |
| Rules | 12 |
| Whole tables | 5 |
| **Total** | **51** |

Across the current three-document corpus: **153 units, from 78 sections.**

Sizes, in characters:

| Type | Smallest | Average | Largest |
|---|---|---|---|
| Rule | 119 | 547 | 1,069 |
| Section prose | 234 | 515 | 1,065 |
| Whole table | 251 | 422 | 560 |
| Table row | 145 | 199 | 305 |

The largest unit of any kind is roughly 280 tokens — comfortably inside every
relevant limit, with no unit approaching a size where truncation could occur.

---

## How the units are searched

Retrieval runs two searches and fuses the results:

- **Meaning-based**, comparing vectors, which finds a passage about the same
  subject even when it shares no vocabulary with the query.
- **Keyword-based**, using a conventional full-text index.

Both matter here. Meaning-based search alone is unreliable on exactly the terms
these documents turn on — `TLS 1.2`, `RPO`, `MFA`, `snake_case`. Detecting that a
design has *failed* to address a requirement depends on being confident the
search would have found it if it were there, so both halves ship together.

---

## What is verified, and how

These properties are checked against the live database rather than assumed:

- **Every rule maps to exactly one unit.** 27 of 27.
- **No rule loses content.** Every requirement bullet stored against a rule is
  confirmed to appear, verbatim, inside that rule's unit.
- **Every unit is indexed.** 153 units, 153 vectors, 153 distinct content
  fingerprints — nothing duplicated, nothing missed.
- **Nothing approaches a truncation limit.** The largest unit is 13% of the
  ceiling at which any trimming would begin.

---

## Honest limits

Three, stated plainly because a client will find them otherwise.

**Scanned documents are rejected.** A PDF with no text layer fails immediately
with a clear message. Optical character recognition is not currently part of the
pipeline. The failure is loud, not silent.

**Rules stated without obligation language are not extracted.** A control table
reading `AES | 256-bit | data at rest` states a requirement, but carries no
*must* or *shall*, so pass 3 declines it rather than inventing an obligation.
Such a section still becomes a searchable prose unit; it simply does not become
something a design is tested against.

**Where extraction fails, it says so.** A section that states an obligation but
yields no rule raises a high-severity review item, and a reference document that
yields no rules at all raises another. An unfamiliar document format surfaces as
a visible review queue rather than as a framework that is quietly smaller than it
appears — which is the failure that actually matters, because a report can
otherwise look complete while testing against half the standard.

---

## Summary in one paragraph

Dexter cuts a standards document along the structure its authors already created,
not at arbitrary character counts. Each rule is stored whole and never divided,
so a requirement is never separated from the principle that gives it meaning.
Tables are indexed row by row, diagrams are read and described, and narrative
text is kept so that no part of the document becomes unsearchable. Every unit
carries its location and a summary so it stands alone. Where the document's
structure cannot be read, the system reports it rather than quietly producing a
smaller framework than the standard actually contains.
