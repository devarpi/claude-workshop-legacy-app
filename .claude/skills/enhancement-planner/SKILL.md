---
name: enhancement-planner
description: >
  Transforms an enhancement request into four comprehensive planning artifacts: HLD (High-Level Design),
  LLD (Low-Level Design), EARS requirements plan, and an Implementation Plan. Use this skill whenever
  a user wants to plan a feature, design a new capability, document an enhancement, or think through
  changes before coding. Trigger for phrases like "plan this feature", "design this enhancement",
  "create a spec for", "I need an HLD/LLD", "write requirements for", "help me plan out", "I want
  to add X to my system", or any request to document or structure work before implementation.
  Even for casual phrasing like "how should I build X?" or "help me think through this change" —
  use this skill to produce structured planning docs.
---

# Enhancement Planner

You help engineers and teams transform an enhancement request into four structured planning documents:
**HLD**, **LLD**, **EARS requirements**, and an **Implementation Plan**.

These documents serve different audiences and purposes:
- HLD: Stakeholders and architects — what are we building and why?
- LLD: Developers — exactly how are we building it?
- EARS: QA, PMs, and developers — what must the system do, stated unambiguously?
- Implementation Plan: Developers and project leads — in what order do we build it?

---

## Step 1: Gather Context

Before writing anything, make sure you have enough context. If the request is vague or missing key information, ask 2–4 focused clarifying questions. Don't ask for information you can get by reading the codebase.

**Check the codebase first** (if one is present in the working directory):
- What language/framework is in use?
- What does the relevant existing code look like?
- What patterns are already established (error handling, data models, API style)?

**Ask clarifying questions only if needed**, such as:
- What problem does this enhancement solve for the user?
- Are there constraints (performance, backward compatibility, deadlines)?
- Who are the primary users/consumers of this feature?
- Are there existing systems or services this must integrate with?
- What does success look like? Any acceptance criteria already in mind?

Once you have enough to proceed, move to the documents. It's better to make reasonable assumptions and note them than to stall indefinitely.

---

## Step 2: Produce the Four Documents

Output all four documents in a single response, clearly separated with `---` dividers and headings. Use markdown throughout.

**File Output**: After producing the documents in the response, also save each one as a `.md` file:
- `design/HLD.md` — High-Level Design
- `design/LLD.md` — Low-Level Design
- `design/EARS.md` — Requirements Plan
- `plan/implementation-plan.md` — Implementation Plan

Create the `design/` and `plan/` directories if they don't exist. Each file should be self-contained with a title header and the full document content.

---

### Document 1: HLD — High-Level Design

**Purpose**: Give stakeholders and architects a clear picture of the system changes — what, why, and how at a 10,000-foot view.

#### Sections to include:

**1. Overview**
- One-paragraph summary of the enhancement and the problem it solves
- Business/user motivation

**2. Goals & Non-Goals**
- Bullet list of what this enhancement will and will not do
- Be explicit about out-of-scope items to prevent scope creep

**3. Architecture Overview**
- Describe the high-level components involved and how they interact
- Include an ASCII diagram or describe the data/control flow clearly
- Highlight what's new vs. what's being modified

**4. Key Design Decisions**
- Major technical choices and the rationale behind them
- Trade-offs considered (e.g., consistency vs. availability, simplicity vs. flexibility)

**5. Dependencies & Integrations**
- External services, libraries, or systems this touches
- Upstream/downstream dependencies

**6. Non-Functional Requirements**
- Performance targets, scalability expectations, security considerations, observability needs

---

### Document 2: LLD — Low-Level Design

**Purpose**: Give developers the detailed technical blueprint to implement the enhancement.

#### Sections to include:

**1. Component Breakdown**
- For each new or modified component: its responsibility, inputs, outputs
- Interface contracts (function signatures, API endpoints, message formats)

**2. Data Model Changes**
- New or modified data structures, schemas, or database tables
- Migrations required
- Example data shapes (JSON, SQL, etc.)

**3. Logic & Algorithms**
- Pseudocode or step-by-step logic for non-trivial flows
- State machines if applicable
- Concurrency or synchronization concerns

**4. API / Interface Design**
- Endpoints, method signatures, or event schemas
- Request/response examples
- Versioning strategy if relevant

**5. Error Handling & Edge Cases**
- Enumerate known failure modes
- How each is detected, logged, and surfaced to the caller
- Retry/fallback strategies

**6. Testing Considerations**
- Unit test surface: which functions/classes need tests?
- Integration test scenarios
- Key assertions to validate

---

### Document 3: EARS — Requirements Plan

**Purpose**: State all requirements unambiguously using the EARS (Easy Approach to Requirements Syntax) format, so they can be directly validated.

EARS uses five sentence templates. Apply whichever pattern fits each requirement:

| Pattern | Template | Use when |
|---|---|---|
| Ubiquitous | `The <system> shall <action>` | Always-true requirements |
| Event-driven | `WHEN <trigger> the <system> shall <action>` | Reactive behavior |
| State-driven | `WHILE <state> the <system> shall <action>` | Ongoing behavior during a state |
| Optional | `WHERE <feature is included> the <system> shall <action>` | Conditional features |
| Unwanted behavior | `IF <condition> THEN the <system> shall <action>` | Error/exception handling |

#### Write requirements in these categories:

**Functional Requirements** — what the system must do
**Performance Requirements** — speed, throughput, latency bounds
**Security Requirements** — auth, authorization, data protection
**Reliability Requirements** — availability, error recovery, data consistency
**Usability / API Ergonomics** — ease of use, discoverability, error messages

Number each requirement (FR-1, PR-1, SR-1, etc.) for traceability.

**Example output style:**
```
FR-1: The system shall persist user preferences across sessions.
FR-2: WHEN a user submits the form the system shall validate all required fields before saving.
FR-3: WHILE an upload is in progress the system shall display a progress indicator.
FR-4: IF the API returns a 5xx error THEN the system shall retry the request up to 3 times with exponential backoff.
PR-1: The system shall return search results within 200ms at the 95th percentile under normal load.
SR-1: The system shall reject requests that lack a valid authentication token.
```

---

### Document 4: Implementation Plan

**Purpose**: Give developers and project leads a concrete, sequenced plan for building the enhancement.

#### Sections to include:

**1. Phases & Milestones**
Break the work into logical phases. A typical structure:
- **Phase 1 – Foundation**: Infrastructure, data models, scaffolding
- **Phase 2 – Core Logic**: Main feature implementation
- **Phase 3 – Integration**: Connecting to existing systems
- **Phase 4 – Polish & Testing**: Edge cases, tests, documentation, review

**2. Task Breakdown**
For each phase, list concrete tasks. Each task should be:
- Actionable (starts with a verb: Create, Implement, Write, Update, Add)
- Completable in 1–2 days by one developer
- Tied to a specific deliverable

Format as a checklist:
```
Phase 1 – Foundation
- [ ] Create database migration for <table>
- [ ] Define data model/schema for <entity>
- [ ] Set up skeleton module/service with placeholder interfaces

Phase 2 – Core Logic
- [ ] Implement <core function>
- [ ] Handle <key edge case>
...
```

**3. Dependencies & Sequencing**
- Note which tasks must complete before others can start
- Flag any external blockers (API keys, access, third-party releases)

**4. Risk Assessment**
- Top 2–4 risks with likelihood and impact
- Mitigation strategy for each

**5. Definition of Done**
- Checklist of criteria that signal the enhancement is complete and shippable
  (e.g., tests passing, docs updated, reviewed, feature-flagged, deployed to staging)

---

## Formatting Guidelines

- Use markdown headings, bullet points, and tables throughout
- Keep each document self-contained — someone should be able to read just the LLD without needing the HLD open
- Make reasonable assumptions explicit: prefix them with `> **Assumption:**`
- If the codebase provides context, reference specific files or patterns (e.g., "following the pattern in `auth/middleware.py`")
- Aim for depth over brevity — these are planning docs, not summaries

---

## Output Structure

Always output in this order:

```
# Enhancement Plan: <name of enhancement>

---

## 1. HLD — High-Level Design
...

---

## 2. LLD — Low-Level Design
...

---

## 3. EARS — Requirements Plan
...

---

## 4. Implementation Plan
...
```

After displaying the full response, save each document as a `.md` file using the Write tool:

```
design/HLD.md          ← HLD content
design/LLD.md          ← LLD content
design/EARS.md         ← EARS requirements content
plan/implementation-plan.md  ← Implementation plan content
```

Each saved file should include a top-level `# <Document Title>: <enhancement name>` heading and the full document content. Notify the user which files were created at the end of your response.
