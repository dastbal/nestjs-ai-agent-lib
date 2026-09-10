# Umbra

[![Umbra](https://img.shields.io/badge/Umbra-Autonomous%20Engineering%20Orchestrator-111111?style=flat-square)](https://github.com/dastbal/umbra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](https://opensource.org/licenses/MIT)

> Built with ❤️ by **David Balladares**.

Umbra is an autonomous engineering orchestrator for **NestJS** projects. It
analyzes, plans, writes, and verifies code with specialized subagents through a
secure streaming CLI. It supports **Google Gemini**, **Anthropic Claude through
Vertex AI**, and local **Ollama** models.

> Requires Node.js 20 or later. Version 2 blocks agent access to credentials,
> `.git`, arbitrary shell commands, and paths outside the workspace.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Getting Started with NestJS](#getting-started-with-nestjs)
  - [Option A — Ollama (Local, Free, No API Key) 🦙](#option-a--ollama-local-free-no-api-key-)
  - [Option B — Google Gemini (Cloud)](#option-b--google-gemini-cloud)
  - [Option C — Anthropic Claude through Vertex AI](#option-c--anthropic-claude-through-vertex-ai)
- [CLI — Interactive Streaming Sessions](#cli--interactive-streaming-sessions)
  - [Session Management](#session-management)
  - [Reasoning — how hard the model thinks](#reasoning--how-hard-the-model-thinks)
  - [Switching Models — `/model` command](#switching-models---model-command)
  - [LLM Switching via env var](#llm-switching-via-env-var)
- [Agent Modes](#agent-modes)
  - [Deep Agent (`deep`)](#deep-agent-deep)
  - [Orchestrator (`orchestrate`)](#orchestrator-orchestrate)
- [Umbra as an MCP server](#umbra-as-an-mcp-server--share-this-codebases-knowledge-with-any-agent)
  - [What it publishes](#what-it-publishes)
  - [Try it in this repository](#try-it-in-this-repository)
  - [Use it on your own repository](#use-it-on-your-own-repository)
  - [Semantic search without a Google account](#semantic-search-without-a-google-account)
- [Architecture](#architecture)
- [Core Concepts](#core-concepts)
  - [NestJS Integration](#nestjs-integration)
  - [Safety Features](#safety-features)
  - [RAG X-Ray Strategy](#rag-x-ray-strategy)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [License](#license)

---

## Overview

This library empowers your NestJS applications with an autonomous AI agent capable of:

- 📋 **Intelligent Planning:** Classifies task complexity (SMALL/MEDIUM/LARGE) and plans execution accordingly.
- 🔍 **Codebase Analysis:** Performs semantic search over your project using Retrieval-Augmented Generation (RAG) for deep understanding (X-Ray strategy).
- 💾 **Safe Code Writing:** Writes code with automatic backups before every file modification.
- 🧪 **Automated Testing:** Integrates with Jest and `tsc --noEmit` for TDD, self-correcting on failures.
- 🤖 **Subagent Delegation:** Spawns specialized "Researcher" and "Coder" subagents for complex tasks.
- ✋ **Human-in-the-Loop (HITL):** Prompts for approval on critical operations like file deletion or infrastructure changes.
- 💬 **Persistent Memory:** Maintains full conversation history via SQLite, enabling continuation across named sessions.
- 🧠 **Context Compression:** Automatically summarizes long conversations to prevent context overflow.
- 🎨 **Beautiful Output:** Renders responses in markdown with rich formatting (chalk, icons, code blocks).
- ⚙️ **Autonomous Execution:** Executes full plans without requiring manual `yes/no` confirmations.
- 🩹 **Self-Healing:** Recovers automatically from corrupted session states.
- 🦙 **Local LLM Support:** Full integration with Ollama, allowing use of models like Gemma4, Qwen3.6, Llama3.2 locally — free, offline, and no API key needed.
- 🟠 **Claude on Vertex AI:** Uses Haiku 4.5, Sonnet 5, or Opus 5 with Google ADC and Google Cloud billing.

## Safe first run

```powershell
# Install once, then use Umbra from any project directory.
npm install -g @dastbal/umbra

# Creates a non-destructive local policy without overwriting an existing one.
umbra init

# Checks Node, local binaries, and configuration without network access.
umbra doctor

# Optional: sends a minimal `Reply only: OK` health prompt to the selected model.
umbra doctor --live

# Safe first task: read-only, evidence-gated analysis.
umbra analyze "Summarize the project architecture"
```

`umbra metrics --since 7 --check` summarizes privacy-safe local telemetry and
returns a non-zero exit code when the configured default health threshold fails.

---

## Key Features

*   **NestJS Native:** Designed from the ground up for NestJS projects.
*   **Domain-Driven Design (DDD) Support:** Understands and can generate code following DDD principles.
*   **Architecture Aware:** Can analyze and refactor code while respecting architectural boundaries.
*   **TDD Workflow:** Integrates seamlessly with Jest for Test-Driven Development.
*   **Multiple LLM Backends:** Supports Google Gemini, Claude partner models on Vertex AI, and Ollama locally.
*   **Codebase Indexing (RAG):** Enables the agent to understand your project's structure and code through semantic search.
*   **Safety First:** Robust file system safety, HITL approvals for destructive actions.
*   **Efficient CLI:** Real-time token streaming and interactive model switching.
*   **Skills System (v1.4):** 12 keyword-triggered skills — the agent automatically loads the right guide for every task (DDD module, tests, refactor, security audit, architecture validation, and more). Base prompt stays lean regardless of how many skills exist.
*   **Mentor Mode (v1.4):** Always-on lightweight mentoring (root cause + trade-off on every response) plus a deep `/mentor` toggle for Socratic dialogue, Forced Output Contract, and architectural decision explanations.
*   **AGENTS.md Context Tiering (v1.4):** Separate context files — `ANTIGRAVITY.md` for the human, `AGENTS.md` for the agent — following OpenHands Context Tiering best practice.

---

## Getting Started with NestJS

### Option A — Ollama (Local, Free, No API Key) 🦙

The recommended and fastest way to start, running entirely on your machine.

**1. Install [Ollama](https://ollama.com) and pull a model:**

```bash
# Recommended model for a balance of quality and performance
ollama pull gemma4        # ~10 GB

# Or, for faster inference with lower RAM usage:
ollama pull gemma4:e2b    # ~7 GB

# Or, for strong reasoning with a compact model:
ollama pull qwen3.6       # ~4 GB
```

**2. Install project dependencies:**

```bash
npm install
```

**3. Configure your environment variables:**

Create a `.env.development` file in the project root:

```dotenv
# .env.development

# Use the model you pulled with Ollama
AGENT_MODEL=ollama:gemma4

# Optional: point Umbra at a different Ollama endpoint.
# The default is http://127.0.0.1:11434 — a literal IP on purpose, because
# resolving "localhost" on Windows costs a DNS lookup that is slow and erratic.
# Set this only if Ollama runs on another host, another port, or IPv6 only:
# OLLAMA_BASE_URL=http://[::1]:11434
```

**4. Run the agent:**

```bash
umbra deep
```

That's it! No Google account or API key needed.

> **Tip:** Inside the agent session, type `/model` to interactively switch between Ollama, Gemini, and enabled Claude models.

---

### Option B — Google Gemini (Cloud)

Leverages Google's powerful Vertex AI models. Requires authentication.

#### Option B1 — Your personal Google account (Recommended for local development) ✅

```bash
# 1. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install
# 2. Umbra asks before launching Google's official browser login flow:
umbra auth login --project YOUR_GCP_PROJECT_ID

# 3. Confirm that credentials exist without displaying a token:
umbra auth status

# 4. Configure your environment variables:
# Create or update .env.development:
# AGENT_MODEL=gemini-2.5-flash-lite

# 5. Run Umbra:
umbra deep
```

#### Option B2 — Service Account (CI/CD, Production)

**Required IAM Role:**
*   `roles/aiplatform.user` (Vertex AI User)

Assign this role to your service account in the GCP Console: **IAM & Admin → IAM → Grant Access**.

```dotenv
# .env.development
# Path to your service account key file
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/your/service-account.json

# Choose your Gemini model
AGENT_MODEL=gemini-2.5-flash-lite
```

---

### Option C — Anthropic Claude through Vertex AI

Claude uses the same Google Application Default Credentials as Gemini, but the
model must first be enabled for your project in Vertex AI Model Garden. Usage is
billed by Google Cloud; a Claude web subscription does not cover Vertex API use.

```dotenv
# Project where the Claude models are enabled
GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID
GOOGLE_CLOUD_LOCATION=global

# Fast and economical
AGENT_MODEL=vertex-anthropic:claude-haiku-4-5@20251001

# Other enabled choices:
# AGENT_MODEL=vertex-anthropic:claude-sonnet-5
# AGENT_MODEL=vertex-anthropic:claude-opus-5
```

For local development, authenticate once with
`umbra auth login --project YOUR_GCP_PROJECT_ID`. Then run `umbra deep` or choose
**Claude** from `/model`. If `GOOGLE_CLOUD_PROJECT` is missing, the selector asks
for the project ID and saves it together with the model before it restarts the
agent. Once set, both the project and the Vertex location can be changed from
**Setup** at the bottom of the `/model` provider list.

---

### Reasoning — how hard the model thinks

Every cloud model exposes a knob for reasoning depth, and no two providers name
it the same. Umbra calls it **Reasoning** everywhere and translates per model,
so the same six levels read the same regardless of who serves the model.

The level is chosen at the end of `/model`, right after the model itself, and
the picklist offers **only the levels that model accepts** — which is what makes
it impossible to save a setting the model would reject. See
[ADR-016](./docs/adr/ADR-016-one-reasoning-vocabulary-across-providers.md).

```dotenv
# low | medium | high | xhigh | max | minimal — empty means the model default
AGENT_REASONING=xhigh

# Show the model's reasoning in the terminal (Claude 5 only)
AGENT_REASONING_DISPLAY=false
```

| Model family | Levels offered | Show reasoning |
|---|---|---|
| Claude Sonnet 5, Opus 5 | `low` `medium` `high` `xhigh` `max` | your choice |
| Claude Haiku 4.5 | `low` `medium` `high` | always on once a level is set |
| Gemini 3.5, 3.1 | `minimal` `low` `medium` `high` | not available |
| Gemini 2.5 | `low` `medium` `high` | always on once a level is set |
| Ollama | — | — |

Three things worth knowing before you turn it up:

- Lower levels cost less and answer faster. `high` is the provider default.
- A level saved for one model is **clamped down**, never up, when you switch to a
  model that lacks it — `max` on Claude Opus 5 becomes `high` on Gemini 3.5.
- On **Claude Haiku 4.5**, setting a level gives up `temperature: 0`. The API
  rejects both together.

---

## CLI — Interactive Streaming Sessions

The agent provides an interactive CLI experience similar to other advanced chatbots, with real-time token streaming and clear status indicators for tool execution.

```
╭──────────────────────────────────────────────╮
│  Umbra · Deep    session auth-module         │
│  🟠 claude-opus-5  ·  reasoning xhigh        │
╰──────────────────────────────────────────────╯

You: Create a UsersModule following DDD principles.

  ⠋  Thinking...
╭─ 📋  write_todos
│  └─ Creating implementation plan...
╰─ ✓  done in 1.2s

╭─ 🔍  ask_codebase
│  └─ How is AuthModule structured for DDD?
╰─ ✓  done in 3.4s

Agent: I will create a UsersModule following the same DDD pattern as AuthModule...
       (tokens stream as they are generated)

──────────────────────────────────────────────────

You: ▋
```

### Session Management

Manage conversation history and context using session IDs.

| Command                                 | Behavior                                                              |
| :-------------------------------------- | :-------------------------------------------------------------------- |
| `umbra deep`                 | **Ephemeral** — Starts a fresh session each time.                     |
| `umbra deep --session auth`  | **Persistent** — Reopens or creates the `auth` session context.       |
| `umbra orchestrate --session feature-x` | Same persistence for the orchestrator mode.                         |
| `umbra deep "Your task"`     | Starts an ephemeral session with an initial human message.            |
| `umbra deep --session session-name "Your task"` | Starts/resumes a named session with an initial message. |

> **Note:** Session data is stored in `.umbra/deep_agent_history.db` and `.umbra/orchestrator_history.db`.

---

### Switching Models — `/model` command

Interact with the agent and switch LLM models on-the-fly without losing your current session context.

```
You: /model

╭────────────────────────────────────────────────────╮
│  🔧  Switch LLM Model                              │
│  Type the number and press Enter.                  │
│  Press 0 or Enter to cancel.                       │
╰────────────────────────────────────────────────────╯

  Select Provider:
  1. ⚡  Gemini  (Google — via Vertex AI)
  2. 🟠  Claude  (Anthropic — via Vertex AI)  ← active
  3. 🦙  Ollama  (Local — free, no API key needed)

  ── configuration ──
  4. ⚙️   Setup   (Google Cloud project and location)
  Provider: 2

  Select Claude Model:
  1. Claude Haiku 4.5  (fast & economical)
  2. Claude Sonnet 5     ⭐ (recommended)  ← active
  3. Claude Opus 5       (maximum capability)
  Model: 3

  Reasoning:
  1. low       (quick answers, simple tasks)
  2. medium    (balanced)
  3. high      (provider default — most coding work)  ← active
  4. xhigh     (hard problems, agentic runs)
  5. max       (correctness over cost)
  6. default   (let the model decide)

  ── show reasoning ──
  7. ☐  Show the model's reasoning  (visibility only — thinking is billed either way)
  Select: 4

  ✅ Switching to vertex-anthropic:claude-opus-5
     reasoning: xhigh
  💾 Saved to .env
  🔄 Restarting agent with new model...
```

The selected model is automatically saved to your `.env` file for future sessions.

### Slash Commands

| Command | Description | State |
|---|---|---|
| `/model` | Switch the active LLM model, its reasoning level, or the Google Cloud setup | — |
| `/mentor` | Toggle deep mentor mode — Forced Output Contract, trade-off analysis, Socratic gates | `[ON]` / `[OFF]` |
| `/help` | Show all available slash commands with their current state | — |
| `Ctrl+C` | Exit the session cleanly | — |

#### Mentor Mode in depth

The agent operates with **two levels of mentoring**:

**Level 1 — Always ON (built into the base prompt)**
Every fix, implementation, or architectural decision includes:
- **Root Cause** — why it broke (not just what)
- **Why this approach** — rationale over alternatives for significant decisions
- **Trade-off** — what's accepted or limited

For changes touching >5 files or public API contracts, the agent pauses and uses `ask_human` before implementing.

**Level 2 — `/mentor` deep mode**
Type `/mentor` to activate the full `skills/mentor-mode.md`:
- **Forced Output Contract** — explicit rationale + trade-offs before every code block
- **Architectural Escalation Gate** — presents alternatives rejected and why
- **Ask-Before HITL Gate** — confirms plan before big changes
- **Socratic Check** — asks if you want to go deeper before implementing concepts
- **Pattern Name Callout** — names the design pattern being applied (Repository, DDD, CQRS, etc.)

Type `/mentor` again to return to standard mode. The always-on Level 1 mentor remains active.

Type `mentor`, `teach me`, `explain why`, or `trade-off` naturally in a message to auto-trigger mentor mode via Progressive Disclosure.

---

### LLM Switching via env var

Alternatively, set the `AGENT_MODEL` environment variable before running the agent.

```powershell
# Windows PowerShell

# ── Ollama (local, free) ──────────────────────────────────────────
# Balanced quality/performance
$env:AGENT_MODEL="ollama:gemma4";       umbra deep

# Fast, low RAM
$env:AGENT_MODEL="ollama:gemma4:e2b";   umbra deep

# High quality (large download)
$env:AGENT_MODEL="ollama:gemma4:26b";   umbra deep

# Strong reasoning, compact
$env:AGENT_MODEL="ollama:qwen3.6";      umbra deep

# General purpose offline
$env:AGENT_MODEL="ollama:llama3.2";     umbra deep

# ── Vertex AI (cloud) ─────────────────────────────────────────────
# Fast & cheap (default if no GOOGLE_APPLICATION_CREDENTIALS)
$env:AGENT_MODEL="gemini-2.5-flash-lite"; umbra deep

# Balanced speed + quality
$env:AGENT_MODEL="gemini-2.5-flash";      umbra deep

# Max capability (architecture, complex refactors)
$env:AGENT_MODEL="gemini-2.5-pro";        umbra orchestrate

# ── Claude through Vertex AI (cloud) ──────────────────────────────
$env:GOOGLE_CLOUD_PROJECT="YOUR_GCP_PROJECT_ID"

# Fast and economical
$env:AGENT_MODEL="vertex-anthropic:claude-haiku-4-5@20251001"; umbra deep

# Recommended for coding and agentic workflows
$env:AGENT_MODEL="vertex-anthropic:claude-sonnet-5";  umbra deep

# Maximum capability
$env:AGENT_MODEL="vertex-anthropic:claude-opus-5";    umbra orchestrate
```

```bash
# Linux / macOS
# Ollama examples
AGENT_MODEL=ollama:gemma4 umbra deep
AGENT_MODEL=ollama:qwen3.6 umbra deep

# Gemini examples
AGENT_MODEL=gemini-2.5-flash-lite umbra deep
AGENT_MODEL=gemini-2.5-pro umbra orchestrate

# Claude through Vertex AI examples
GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID AGENT_MODEL=vertex-anthropic:claude-haiku-4-5@20251001 umbra deep
GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID AGENT_MODEL=vertex-anthropic:claude-sonnet-5 umbra deep
```

**Available Model Tiers:**

| Tier Alias | Model String             | Provider   | Best For                               |
| :--------- | :----------------------- | :--------- | :------------------------------------- |
| `gemma`    | `ollama:gemma4`          | 🦙 Local    | Best local model for general coding    |
| `gemma-2b` | `ollama:gemma4:e2b`      | 🦙 Local    | Fast, low RAM (~7 GB)                  |
| `gemma-4b` | `ollama:gemma4:e4b`      | 🦙 Local    | Balance speed/quality (~9.6 GB)        |
| `gemma-26b`| `ollama:gemma4:26b`      | 🦙 Local    | Max quality (~17 GB)                   |
| `qwen`     | `ollama:qwen3.6`         | 🦙 Local    | Strong reasoning, compact (~4 GB)      |
| `local`    | `ollama:llama3.2`        | 🦙 Local    | General purpose offline                |
| `lite`     | `gemini-3.1-flash-lite`  | ⚡ Cloud    | Quick edits, Q&A (cheapest)           |
| `flash`    | `gemini-3.5-flash`       | ⚡ Cloud    | Balanced speed + quality (recommended) |
| `pro`      | `gemini-2.5-pro`         | ⚡ Cloud    | Architecture, complex refactors        |
| `3.5-lite` | `gemini-3.5-flash-lite`  | ⚡ Cloud    | Fast, high-volume workloads            |
| `claude-fast` | `vertex-anthropic:claude-haiku-4-5@20251001` | 🟠 Vertex | Fast, economical Claude work |
| `claude` | `vertex-anthropic:claude-sonnet-5` | 🟠 Vertex | Coding and agentic workflows |
| `claude-max` | `vertex-anthropic:claude-opus-5` | 🟠 Vertex | Architecture and hard problems |

The `/model` menu still displays **Claude Haiku 4.5**. Its dated suffix is the
Vertex transport version confirmed for that model and is selected automatically.

> **Embeddings Note:** For Retrieval-Augmented Generation (RAG), the agent consistently uses **Vertex AI's `text-embedding-004`** model, regardless of the chat model selected. This keeps one stable codebase index when switching among Ollama, Gemini, and Claude.

---

## Agent Modes

### Project initialization and policy

Run this once inside the project you want the agent to operate on:

```bash
umbra init
```

During initialization Umbra optionally offers to connect LangSmith. It explains
that remote tracing can include prompts, model responses, tool activity, and
metadata, then asks for the API key without echoing it. Choosing no keeps
tracing off and changes nothing. Enable it later with:

```bash
umbra setup langsmith
```

Credentials are saved only in `.umbra/langsmith.env`, which Umbra ignores in
Git; they are never written to `.umbra/agent.config.json` or local telemetry.

The command is idempotent and creates `.umbra/agent.config.json` only when it is
missing. The file is local runtime state (and remains ignored by Git), so each
project can choose its own model routing and safety limits. The first iteration
keeps one delegation level and one writer: Researcher is read-only, Coder is the
only writer, and Verifier is read-only and runs tests plus the TypeScript check.
Handoffs are compact structured artifacts rather than full transcripts.

For interactive `deep` work, the default recursion budget is 50 graph
transitions (hard maximum 60). A per-turn middleware allows at most eight tool
attempts; after that it removes tools from the next model call so the model must
synthesize the evidence already collected. Each interactive turn also appends
privacy-safe metrics to `.umbra/telemetry/interactive-turns.jsonl` and adds its
audit ID, model, mode, and budgets to the matching LangSmith trace. The local
record never stores prompts, tool arguments, response content, credentials, or
raw provider errors.

For architecture reviews, audits, and performance questions use the dedicated
evidence-gated mode. It is one-shot, read-only, injects a bounded workspace
manifest, and requires cited paths in the structured response:

```bash
umbra analyze "Evalúa el propósito, flujo, memoria y cuellos de botella del proyecto"
```

To keep this audit predictable and cheap, `analyze` answers only from its
machine-collected, path-and-line manifest; it does not launch RAG searches or
re-read files. Missing evidence is reported as `No verificado`. Use `deep` or
`orchestrate` when the task needs an interactive investigation beyond that
bounded report.

### Model routing: cost first, quality where it matters

`AGENT_MODEL` selects the primary model for the current `deep` or
`orchestrate` session. It does **not** overwrite the specialized models inside
the orchestrator: the project policy keeps the Researcher, Coder, and Verifier
on their own profiles. By default, the Coder uses `gemini-2.5-pro` while the
other roles use `gemini-2.5-flash-lite` to preserve cost efficiency.

For a single quality-sensitive review, leave your economical `.env` unchanged
and pass an explicit model just for that run:

```powershell
# A high-quality, read-only architecture or performance review
umbra analyze --model gemini-2.5-pro "Evaluate the project purpose, flow, memory, and performance bottlenecks"

# A stronger Supervisor for one complex implementation session
umbra orchestrate --model gemini-2.5-pro --session architecture-review
```

The precedence is: explicit `--model` > `AGENT_MODEL` > project role profile.
The role profiles and safety limits are visible and editable in
`.umbra/agent.config.json`; `umbra init` never overwrites an existing file.

### What one turn is allowed to spend

Every interactive turn is bounded on four dimensions, and stops at whichever it
reaches first. The defaults come from measured sessions, not from taste:

| Ceiling | Default | Why |
| --- | --- | --- |
| Tool calls | 8 | 98 of 120 recorded turns used three or fewer |
| Tokens | 250,000 | prompt plus completion, across the whole turn |
| Wall clock | 300 s | above the 95th percentile of recorded turns (238 s) |
| Cost | unset | set `limits.maxCostUsd` in `.umbra/agent.config.json` to enforce it |

When a ceiling is reached the turn is not aborted: the model loses its tools and
is told which ceiling ran out, so it answers with the evidence it already has
and states what it could not verify.

The running total appears live on the wait indicator — `7 calls · 51.0k tok ·
$0.0846` — so a turn that is going wrong can be stopped while it happens. Cost
is shown only when the active model has a published price; an unpriced model
shows no figure rather than a misleading `$0.00`.

A greeting, a thank-you or a farewell is answered directly by the CLI with no
model call at all. Affirmations such as `ok`, `dale` or `seguí` are deliberately
**not** treated as small talk — they usually mean *proceed*, and answering one
locally would refuse work you just approved.

Diagnostics: set `UMBRA_BUDGET_PROBE=1` to append a shape-only record of what
the budget middleware observes to `.umbra/telemetry/budget-probe.jsonl`. It
stores counts and message types, never message content, and is off by default.

See [ADR-019](docs/adr/ADR-019-turn-cost-is-the-bound-not-tool-calls.md) and
[ADR-020](docs/adr/ADR-020-a-message-that-asks-for-nothing-costs-nothing.md).

### Deep Agent (`deep`) — Single Autonomous Agent

Ideal for most day-to-day tasks: debugging, code analysis, single-file modifications, quick questions, and medium-complexity features.

```bash
# Start an ephemeral session
umbra deep

# Start a persistent session named "my-feature"
umbra deep --session my-feature

# Ask a specific question about a file
umbra deep "explain src/core/agent/deep-agent-factory.ts"
```

**Task Sizing:** The agent automatically classifies tasks before execution:
*   **SMALL:** (1-2 files, straightforward changes) → Executes directly (Read → Write → Done). Max 3 tool calls.
*   **MEDIUM:** (3+ files, new feature) → Creates a brief `write_todos` plan and executes it.
*   **LARGE:** (Entire module, major refactor) → Follows a detailed, step-by-step plan using `write_todos`.

**Core Tools:**
*   `write_todos`: Plans and tracks multi-step tasks.
*   `list_files`: Lists directory contents.
*   `list_adrs`: Returns a cached catalog of ADR paths, status, and context; the agent reads only the ADR selected for a decision-history task.
*   `safe_read_file`: Reads file content safely.
*   `safe_write_file`: Writes to files with automatic backups.
*   `ask_codebase`: Performs semantic search over your codebase using RAG.
*   `refresh_project_index`: Rebuilds the RAG index (e.g., after bulk file writes).
*   `run_integrity_check`: Runs `tsc --noEmit` to ensure type safety.
*   `query_nest_graph`: Answers NestJS dependency-injection questions — which module binds a token, which classes inject it, what one module binds.
*   `run_tests`: Executes Jest test suites.

---

### Orchestrator (`orchestrate`) — Multi-SubAgent Coordinator

Best suited for complex, large-scale tasks such as implementing entire modules, significant refactoring efforts, or adding major features that span multiple files and components.

```bash
# Start an ephemeral orchestrator session
umbra orchestrate

# Start a persistent session for a major refactor
umbra orchestrate --session big-refactor
```

**Mandatory Workflow:** The orchestrator strictly follows a predefined protocol to ensure thoroughness and quality:
1.  **`write_todos`:** Creates a comprehensive plan covering analysis, implementation, and verification.
2.  **`task(researcher)`:** Delegates analysis to the `researcher` subagent, which examines the codebase and produces a detailed implementation plan.
3.  **`task(coder)`:** Delegates implementation to the `coder` subagent, which follows the researcher's handoff, adheres to Test-Driven Development (TDD), and writes tests *before* implementation.
4.  **`task(verifier)`:** Runs focused tests and the TypeScript integrity check without write access.
5.  **Correction loop:** Allows at most the configured `maxRetries` automatic correction cycles before reporting a blocker.

**Subagents:**
*   **Researcher:** A read-only analyst. Uses tools like `ask_codebase` and `safe_read_file` to understand the project and generate structured plans.
*   **Coder:** An implementation specialist. Uses `safe_write_file`, `run_tests`, and `run_integrity_check`. Writes `.spec.ts` files first, then implements the corresponding code. Self-corrects up to the configured `maxRetries` upon test failures.
*   **Verifier:** A read-only quality gate. Runs tests and type-checks, then returns compact evidence and remaining issues.

---

## Umbra as an MCP server — share this codebase's knowledge with any agent

`umbra mcp` publishes what Umbra knows about **one repository** to any Model
Context Protocol client — Claude Code, Codex, Cursor, Gemini CLI — over stdio.
It answers; the client thinks.

There is **no chat model or agent loop inside it**. MCP tools answer through
deterministic code and cannot write files or run commands. After Umbra has
validated a project root, its background warm-up may create that root's local
`.umbra/` cache, protect it in `.gitignore`, and call the configured embedding
provider; no MCP tool can select a path or request any of those writes.

Decided in [ADR-024](docs/adr/ADR-024-umbra-as-a-read-only-mcp-server.md).

### What it publishes

| Kind | Name | What it answers |
|---|---|---|
| Tool | `list_adrs` | *Why* is the code shaped this way — path, title, status of every decision record, without their bodies |
| Tool | `query_dependency_graph` | *What breaks if I change this file* — inbound or outbound imports, from the AST |
| Tool | `query_nest_graph` | *Which module provides this token, and who injects it* — NestJS wiring, including modules whose providers live in a `forRoot()` rather than in the `@Module` decorator |
| Tool | `run_integrity_check` | `tsc --noEmit` over the served repository |
| Tool | `ask_codebase` | Semantic search in natural language, with the index's provenance on every answer |
| Tool | `get_index_status` | Live warm-up state plus durable discovery, chunk, vector, stamp, and lease coverage |
| Resource | `umbra://adr-index` | The ADR catalog |
| Resource | `umbra://index-status` | The same truthful index status as `get_index_status` |
| Prompt | one per `skills/*.md` | The working guides the package ships |

`ask_codebase` is always visible in the stable catalog, but it cannot search
until the selected provider has produced complete durable vector coverage. Until
then it returns a retryable status directing the client to `get_index_status`;
the other read-only tools remain available once the project root is validated.

### Try it in this repository

For a repository-local manual check, install dependencies and build it:

```bash
npm install                            # includes the build toolchain
npm run build
```

For an installed global client entry, run `umbra setup claude` once and then
start Claude Code in this directory. Umbra validates and activates this project
only after the client supplies its root. Verify the user-scoped entry with:

```bash
claude mcp list
```

`umbra` should read `✔ Connected`. Then ask any agent in that session
*"list this project's ADRs using Umbra"*.

To check it by hand, without a client:

```bash
node dist/bin/cli.js mcp --root .
```

It waits for a client and prints its startup to **stderr**:

```
[umbra mcp] umbra mcp — serving /path/to/repo
[umbra mcp] publishing 6 tools: ask_codebase, get_index_status, list_adrs, query_dependency_graph, query_nest_graph, run_integrity_check
[umbra mcp] MCP transport connected; index warm-up continues in the background.
```

During a cold index it also prints per-file progress, percentage, embedding
batch and elapsed time. An interactive `umbra deep` terminal repaints one
concise status line instead of flooding the console; redirected output and MCP
diagnostics retain complete lines. If Ollama is still loading or embedding after
15 seconds, a heartbeat names the exact file and batch. MCP diagnostics always
use `stderr`, never JSON-RPC `stdout`.

The server connects before it probes Ollama or indexes. Use
`get_index_status` while it warms; Ctrl+C stops the manual check.

### Use it on your own repository

Install the CLI once per user, then configure a verified client once:

```bash
npm install -g @dastbal/umbra@<published-version>
umbra setup mcp
```

`setup mcp` detects Codex and Claude, shows the global `umbra mcp --auto-root`
command, asks before changing anything, and verifies its own entry. Replace
`<published-version>` with an npm version that exists; this repository's
unpublished release candidate is not installed by that command. `npx -y
@dastbal/umbra@<published-version> init` remains useful for manually
initializing a project, but it is not the global MCP launcher. No install hook
or postinstall writes client configuration.

**Why `npx` is not the launcher, measured.** `-y` answers the install prompt; it
does not skip the registry lookup, so every launch depends on the network.
Timing spawn to the MCP `initialize` response — the window a client's connect
timeout measures — `npx` ran between 11.7 s and 24 s and, in one run of six,
never answered inside 60 s. The installed binary was consistently around 12 s on
the same build, and 4.4 s once the indexer stopped loading before the handshake.
A client with a 30-second timeout therefore fails *intermittently* through
`npx`, which is harder to diagnose than failing every time. See ADR-024
amendment 15.

Run the flow again at any time:

```bash
umbra setup mcp       # detect and configure global Codex and Claude entries
umbra setup codex     # configure and verify global Codex only
umbra setup claude    # configure and verify global Claude only
```

That one registration works for every repository you later open. When Claude
starts Umbra, it supplies its active project through `CLAUDE_PROJECT_DIR`; Codex
uses the directory from which it launches the MCP process. Umbra validates that
directory. If a globally configured client cannot supply a valid launch
directory, Umbra requests exactly one local MCP Root after the handshake. It
rejects no root, multiple roots, remote URIs, homes, temporary roots, and
undeclared folders. Only after a root is accepted does it create
`<project>/.umbra/`, protect it in `.gitignore`, and start background indexing.
A server never accepts a path from an MCP tool call.

If a client cannot identify an active project, Umbra stays connected but
root-gated: `get_index_status` gives the actionable recovery message and no
`.umbra/`, `.gitignore`, database, provider call, or index run occurs. Open the
client from the repository and reconnect it.

Codex is configured through `codex mcp add` and verified with `codex mcp get
umbra`; restart an existing Codex session afterwards. Claude is configured with
`claude mcp add --scope user` and verified with `claude mcp get umbra`. On native
Windows, its adapter uses the documented `cmd /c umbra` wrapper. Other MCP clients
receive this standard definition to copy, rather than Umbra guessing their
configuration format:

```json
{
  "mcpServers": {
    "umbra": {
      "type": "stdio",
      "command": "umbra",
      "args": ["mcp", "--auto-root"]
    }
  }
}
```

That is the whole global setup. The MCP SDK ships as Umbra's production runtime
dependency, so the first handshake never downloads a package. A project-scoped
entry remains available when a team deliberately wants to pin a single root;
use `umbra mcp --root <absolute-project-root>` for that case.

**Needs 2.2.0 or later.** Earlier published versions have no `mcp` subcommand at
all.

| Flag | Meaning |
|---|---|
| `--root <path>` | Explicit repository to serve. Fixed at launch; no tool argument can change it |
| `--auto-root` | Resolve the trusted active client project, then pin it for this process. Used by global MCP setup |
| `--embeddings <vertex\|ollama>` | Provider for semantic search. Defaults to `.umbra/agent.config.json`, else `ollama` |
| `--no-index` | Do not warm the semantic index at launch |

After a first index, verify durable coverage without calling an embedding
provider:

```bash
umbra doctor --index
```

It reads no provider. It reports the root's `.umbra/memory.db`, declared source
coverage, indexed/skipped file outcomes, chunks, vectors per provider/model and
dimension, missing or zero-chunk files, stale source paths, stamp consistency,
and a live/stale index lease. It exits non-zero if semantic coverage is not
durably proven. Vectors live in `chunk_vectors`, keyed by `(chunk_id, provider,
model)`; `file_registry` alone only proves that a file was seen, not that it is
searchable.

### Monorepo discovery

Umbra discovers TypeScript source from package `tsconfig.json` files and workspace
declarations, not from a guessed root `src/`. It ignores dependency/build trees,
indexes `.ts` and `.tsx` including classless utility/configuration modules, and
keeps all stored paths relative to the fixed
`--root`. If a repository's declared source boundary needs an explicit override,
commit an `umbra.json` at its root:

```json
{ "indexing": { "sources": ["apps/*/src/**/*.ts", "apps/web/features/**/*.tsx"] } }
```

`list_adrs` also discovers module catalogs such as `docs/payments/adr/`; its
optional `module` argument filters the result. The `.umbra/` directory, including
`memory.db`, is local root-bound cache state: it is safe to delete and should be
gitignored. `umbra init` adds that ignore rule without rewriting existing rules.

Prefer putting the provider in `.umbra/agent.config.json`, rather than making
the client MCP configuration provider-specific. That root-local file is
gitignored, so each person chooses without changing what the team shares:

```json
{ "rag": { "embeddings": "ollama" } }
```

### Semantic search without a Google account

`ask_codebase` needs an embedding provider, and **the default is local, free and
offline** ([ADR-027](docs/adr/ADR-027-the-default-is-the-one-that-costs-nothing.md)).
One command and semantic search works with no cloud account:

```bash
ollama pull nomic-embed-text
```

**Google Vertex** is fully supported and one line away. It costs cents per query
and needs Application Default Credentials:

```bash
umbra auth login
```

```json
{ "rag": { "embeddings": "vertex" } }
```

in `.umbra/agent.config.json`, which is gitignored — so each person on a team
chooses without changing what the repository shares. `UMBRA_EMBEDDINGS=vertex`
and `--embeddings vertex` do the same thing for one run.

### Choose the provider before indexing

Inside an interactive CLI session, use `/model` and select **Embeddings**. The
choice is stored only in `.umbra/agent.config.json`; it does not change your
chat model and it does not start a billable rebuild by itself.

For a one-off or scripted rebuild, choose the provider explicitly:

```bash
umbra index --embeddings ollama
umbra index --embeddings vertex
```

The command checks the selected provider before writing vectors. It never
substitutes Vertex for Ollama or vice versa, so a missing local model or Google
credential is reported before any index is changed.

Switching is reversible and never destroys the other index: each provider's
vectors are stored under their own identity, so switching back requires no
re-indexing, and querying an index built by the *other* provider raises an
explicit error naming the fix rather than answering from the wrong vectors
([ADR-025](docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md),
[ADR-026](docs/adr/ADR-026-vectors-are-numbers-and-the-database-can-count.md)).

If no provider is available, `ask_codebase` remains advertised but returns its
typed retryable status; the other root-bound read-only tools remain available.

> Upgrading from 2.1.x with a Vertex-built index and no `rag.embeddings` in your
> config? The first query reports the mismatch and names both fixes: set
> `vertex` in the config, or let it re-embed locally.

### Why the SDK ships with Umbra

`@modelcontextprotocol/sdk` is an exact production dependency. A globally
configured `umbra mcp` process must complete its first handshake without asking
the MCP client to download a second package, so the runtime is intentionally
self-contained.

### Removing it

Remove the user entry with `claude mcp remove umbra` or `codex mcp remove umbra`.
There is nothing else to undo: no daemon, no credentials handed out, and each
project keeps only its own gitignored `.umbra/` directory.


---

## Architecture

```mermaid
graph TD
    subgraph CLI Interface
        A[Interactive Stream]:::cli --> B(Session Management);
        B --> C[/model Command];
        B --> D[Model Switching Logic];
        B --> E[Agent Mode Selection];
    end

    subgraph Agent Core
        E --> F(DeepAgentFactory);
        F --> G[LLMProvider];
        G -- Ollama --> H(OllamaChatAdapter);
        G -- Gemini --> I(ChatVertexAI);
        G -- Claude on Vertex --> R(ChatAnthropic + AnthropicVertex);
        F -- Simple Agent --> J(createDeepAgent);
        F -- Orchestrator --> K(createDeepAgent);
        K --> L[Researcher Subagent];
        K --> M[Coder Subagent];
    end

    subgraph Services & Tools
        J --> N(Core Tools);
        K --> N;
        N --> O(SafeFilesystemBackend);
        N --> P(RAG IndexerService);
        N --> Q(Checkpointer SqliteSaver);
        J --> Q;
        K --> Q;
    end

    classDef cli fill:#4CAF50,stroke:#333,stroke-width:2px;
    classDef session fill:#FFC107,stroke:#333,stroke-width:2px;
    classDef modelcmd fill:#2196F3,stroke:#333,stroke-width:2px;
    classDef mode fill:#FF9800,stroke:#333,stroke-width:2px;
    classDef factory fill:#9C27B0,stroke:#333,stroke-width:2px;
    classDef subagent fill:#00BCD4,stroke:#333,stroke-width:2px;

    class A cli;
    class B session;
    class C modelcmd;
    class E mode;
    class F factory;
    class L,M subagent;
```

*   **CLI:** Handles user interaction, model switching (`/model`), and session management.
*   **Agent Core:** `DeepAgentFactory` orchestrates agent creation, routing requests to either a simple `DeepAgent` or a multi-subagent `Orchestrator`.
*   **LLM Integration:** `LLMProvider` routes local models to `OllamaChatAdapter`, Gemini to `ChatVertexAI`, and Vertex-hosted Claude to `ChatAnthropic` with Anthropic's Vertex client.
*   **Services & Tools:** Provides core functionalities like safe file operations, RAG indexing, conversation persistence (SQLite), and the underlying LLM tooling.

---

## Core Concepts

### NestJS Integration

This library is built with NestJS in mind. It understands NestJS conventions for project structure, modules, services, controllers, and DDD. When you ask the agent to perform tasks like "create a user module" or "add authentication to this service," it leverages its knowledge of NestJS patterns to generate appropriate, idiomatic code.

### Safety Features

*   **`safe_write_file`:** Before writing any file, the agent creates a timestamped backup in `.umbra/backups/`. This ensures you can always revert to the previous version if the agent's changes are not as expected.
*   **Project Root Sandboxing:** The agent operates strictly within the project's root directory. It cannot access or modify files outside this scope.
*   **Human-in-the-Loop (HITL):** For potentially destructive operations (e.g., deleting files/directories, dropping database tables, modifying infrastructure files like `docker-compose.yml` or `.env.production`), the agent will pause and explicitly ask for your approval.

### RAG X-Ray Strategy

The agent uses Retrieval-Augmented Generation (RAG) to understand your codebase:
1.  **Indexing:** The `IndexerService` discovers declared TypeScript sources from the served root, including monorepo packages. It records durable file, chunk, vector, and provider/model coverage in that root's `.umbra/` state.
2.  **Semantic Search:** When you ask questions about your code, the `ask_codebase` tool performs a vector similarity search against the index.
3.  **Contextual Understanding:** The search results provide relevant code snippets and dependency information, giving the LLM a deep understanding of your project's structure and logic.

*   **Ollama Mode:** Ollama is the default local embedding provider. If its model is unavailable, Umbra reports the retryable reason and preserves the previous durable index instead of claiming a completed search surface.

---

## Project Structure

The library follows a clean, modular structure:

```
/umbra
├── src/
│   ├── bin/                      # CLI entry points (deep, orchestrate)
│   │   └── cli.ts
│   ├── core/                     # Core agent logic & services
│   │   ├── agent/                # Agent factories (DeepAgentFactory)
│   │   │   ├── factory.ts        # Legacy ReAct agent
│   │   │   ├── graph-factory.ts  # Legacy StateGraph agent
│   │   │   └── deep-agent-factory.ts  # ⭐ Active: Creates DeepAgent & Orchestrator
│   │   ├── config/               # Configuration loading (env vars, model resolution)
│   │   │   ├── model-resolver.ts
│   │   │   └── model-switcher.ts
│   │   ├── llm/                  # LLM provider routing & adapters
│   │   │   ├── provider.ts
│   │   │   └── ollama-adapter.ts # Handles Ollama's specific API requirements
│   │   ├── subagents/            # Specialized agents for orchestration
│   │   │   ├── coder.subagent.ts
│   │   │   └── researcher.subagent.ts
│   │   ├── rag/                  # Retrieval-Augmented Generation
│   │   │   └── indexer.ts        # Codebase indexing service
│   │   └── tools/                # Custom tool implementations (safe file ops, etc.)
│   │       └── index.ts
│   ├── presentation/             # CLI UI and presentation logic
│   │   ├── cli/
│   │   │   ├── chat-session.ts   # Main interactive loop + slash command dispatcher
│   │   │   ├── model-menu.ts     # Interactive model selection UI
│   │   │   ├── stream-renderer.ts # Output formatting (tokens, tools, Agent header)
│   │   │   ├── markdown-renderer.ts # Markdown → chalk styled terminal output
│   │   │   └── theme.ts          # CLI styling and icons
│   │   └── index.ts
├── skills/                       # ⭐ Agent skills — keyword-triggered, read-only
│   ├── create-ddd-module.md      # DDD module creation protocol
│   ├── write-tests.md            # TDD & Jest spec templates
│   ├── refactor-safely.md        # Inside-out refactor, find callers first
│   ├── create-endpoint.md        # REST endpoint + DTO + Swagger
│   ├── debug-typescript.md       # TS error lookup table & fix protocol
│   ├── analyze-codebase.md       # Read-only RAG analysis mode
│   ├── evaluate-own-work.md      # Self-review checklist before "done"
│   ├── git-workflow.md           # Conventional commits & version branching
│   ├── security-audit.md         # OWASP API Top 10 for NestJS
│   ├── research-output-format.md # Structured Researcher→Coder handoff (MetaGPT SOP)
│   ├── validate-architecture-boundaries.md  # DDD forbidden import detector
│   └── mentor-mode.md            # Deep mentor: Forced Output Contract + Socratic gates
├── AGENTS.md                     # ⭐ Project context for AI agents (read-only)
├── ANTIGRAVITY.md                # ADR log & work history for the human developer
├── .umbra/                       # Agent runtime data
│   ├── deep_agent_history.db     # SQLite DB for named deep agent sessions
│   ├── orchestrator_history.db   # SQLite DB for named orchestrator sessions
│   ├── index.meta.json           # Timestamp for RAG index freshness
│   └── backups/                  # Timestamped backups before each file write
├── .env.development              # Example environment file
├── package.json
└── tsconfig.json
```

---

## Roadmap

| Phase | Feature | Status |
|---|---|---|
| **v1.0** | Foundational Deep Agent (`deep` mode) | ✅ Done |
|   | Basic LLM switching (env var) | ✅ Done |
|   | Core tools (filesystem, RAG basic) | ✅ Done |
| **v1.1** | Orchestrator (`orchestrate` mode) | ✅ Done |
|   | Researcher & Coder subagents | ✅ Done |
|   | TDD workflow enforcement | ✅ Done |
| **v1.2** | Advanced CLI Features | ✅ Done |
|   | Interactive `/model` switching | ✅ Done |
|   | Session persistence & management | ✅ Done |
|   | Context compression | ✅ Done |
|   | Safety: Auto-recovery, HITL | ✅ Done |
| **v1.3** | **Ollama Local Inference Support** | ✅ **Done** |
|   | Full multi-provider routing | ✅ Done |
|   | `OllamaChatAdapter` for compatibility | ✅ Done |
|   | Support for `gemma4`, `qwen3.6`, `llama3.2` | ✅ Done |
| **v1.4** | **Skills System & Mentor Mode** | ✅ **Done** |
|   | 12 keyword-triggered skills (`skills/*.md`) | ✅ Done |
|   | Progressive Disclosure — keyword map in base prompt | ✅ Done |
|   | FILE PROTECTION LAW (skills + ANTIGRAVITY + AGENTS.md) | ✅ Done |
|   | `AGENTS.md` Context Tiering (agent vs. human save state) | ✅ Done |
|   | Always-on lightweight mentor (base prompt invariant) | ✅ Done |
|   | `/mentor` deep mode (Forced Output Contract + Socratic gates) | ✅ Done |
|   | Structured Researcher→Coder handoff (`research-output-format.md`) | ✅ Done |
|   | DDD layer boundary validator (`validate-architecture-boundaries.md`) | ✅ Done |
| **v1.4.2** | **Stability & CLI Polish** | ✅ **Done** |
|   | Bug: `MODEL_TIERS` expansion — `resolveModel()` never used tiers (silent crash) | ✅ Fixed |
|   | Bug: Fake Anthropic — `claude` removed from tiers, honest error on unsupported provider | ✅ Fixed |
|   | Bug: Phase 2 proactive auto-compression — `checkAndCompressContext()` after every turn | ✅ Fixed |
|   | Bug: `reflect-metadata` CLI crash — removed dead `@Injectable()` from 3 services | ✅ Fixed |
|   | CLI: Richer markdown renderer — code blocks with full `╭──╮` borders, header icons (`★`, `❖`, `›`), 2-space global indent | ✅ Done |
|   | CLI: `⬆ Agent ────` header replaces plain `Agent:` label | ✅ Done |
| **v1.5.0** | **LangSmith Observability** | ✅ **Done** |
|   | langsmith SDK integration via auto-instrumentation | ✅ Done |
|   | Zero-code tracing: all LLM calls, tool calls, LangGraph steps | ✅ Done |
|   | Configure with 3 env vars: LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT | ✅ Done |
|   | No-op when env vars are absent (safe for library consumers) | ✅ Done |
| **v2.0.1** | **Claude partner models through Vertex AI** | ✅ **Done** |
|   | Haiku 4.5, Sonnet 5, and Opus 5 routing and `/model` presets | ✅ Done |
|   | Google ADC transport, Anthropic harness profile, and packaged pricing | ✅ Done |
| **Future** | SSE HTTP API (`/agent/stream`) | ⏳ Planned |
|   | Agent self-evolution — write new skills from patterns it discovers | ⏳ Planned |
|   | LangGraph state-level mentor toggle (true per-session stateful mode) | ⏳ Planned |

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
