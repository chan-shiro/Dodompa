# Dodompa

> 🇯🇵 日本語版: [README.ja.md](README.ja.md)

**RPA for AI.** Built for the automations you'll run a hundred times — so the same work doesn't pay the full LLM bill every time. Open source, MIT licensed.

**Dodompa** — **D**ynamic **O**rchestration and **D**evelopment **O**f **M**achine **P**rocess **A**utomation.

## Why

Computer Use is brilliant for one-off work: describe what you want, Claude figures it out end-to-end. But the moment the *same* workflow has to run every morning, every deploy, or every incoming ticket, paying the full LLM tab and waiting for re-planning on every single execution gets expensive and slow.

Dodompa solves this by **doing the expensive AI planning exactly once, not on every run**. On the first successful run, the AI writes the automation out as a plain TypeScript file. From then on, Dodompa just runs that file — no re-planning, no repeated navigation token cost, no re-asking the model whether this button is the right button. AI is only consulted again for the specific decisions your task explicitly asks for.

- **First run:** natural-language instruction → AI decomposes it into steps → generates real TypeScript → runs it → self-heals until it works.
- **Every run after:** the generated TypeScript executes directly. No re-planning, no navigation tokens — the only AI calls are the `ctx.ai(...)` your code explicitly makes. Faster and cheaper by orders of magnitude, and deterministic.
- **When something breaks:** AI diagnoses the failing step and patches *that step only*. The rest stays frozen in code.
- **When a step needs real judgment:** the code can call `ctx.ai("...")` inline, or prompt the user for input.

The result: **plan once, execute forever with minimal AI overhead** — you pay for planning on run 1, and from run 2 onward you only pay for the judgment calls your code genuinely needs.

## When Dodompa pays off (and when it doesn't)

| Situation | Better choice |
|---|---|
| One-off exploration — "I just need this done once" | **Computer Use.** No point generating reusable code for a throwaway. |
| Same workflow ≥3 times (daily report, recurring scrape, morning setup, per-PR check…) | **Dodompa.** Pay the planning cost on run 1; subsequent runs skip planning and only call AI where your task explicitly asks for a decision. |
| You want a colleague to run it, fork it, or audit it | **Dodompa.** Output is a plain `.ts` file — readable, diff-able, PR-able. |
| A purely conversational request | Claude directly. Dodompa is about producing runnable artifacts. |

The axis is simple: **is this task worth crystallizing?** If you'll run it again, Dodompa saves tokens and wall-clock time. If not, skip the indirection.

## What Dodompa drives

- **Browsers** — Playwright on real Chromium. Logins, forms, scraping, multi-tab flows, authenticated SaaS.
- **macOS desktop apps** — Accessibility API + keyboard/mouse + AppleScript. Mail, Finder, Notes, Slack, Excel, Calculator, and anything else that exposes UI.

Mixed tasks work too — one Dodompa task can open an app, copy something, then continue in the browser.

## Why code, not a visual editor?

No-code RPA is fine until your flow needs branching, retries, API calls, data shaping, or loops — then you hit the ceiling of the drag-and-drop surface. Dodompa's output is just TypeScript. You can read it, edit it, import libraries, run it locally, diff it in Git. The division of labor we like: **AI writes the draft, a human tweaks it when they want.**

## How it works

```
natural-language task
        │
        ▼
  ┌───────────┐    plan      ┌──────────┐   generate    ┌────────┐
  │ planning  │ ───────────▶ │ codegen  │ ───────────▶ │ run it │
  └───────────┘              └──────────┘               └────┬───┘
        ▲                                                    │
        │           fix only the failing step                │
        └──── analyzer + patch agents ◀─── on failure ──────┘

            Subsequent runs: skip everything above and just `run it`.
```

Every agent in the pipeline has a single job (planning, codegen, selector resolution, failure analysis, patching). Details and I/O specs live in [AGENTS.md](AGENTS.md) and [docs/agent-reference.md](docs/agent-reference.md).

## Tech stack

| Layer | Tech |
|-------|------|
| App shell | Electron |
| UI | React + TypeScript + Tailwind CSS + i18next |
| Browser automation | Playwright (`playwright-core`) |
| Desktop automation | Swift CLI (`dodompa-ax`) + AppleScript + Python/Quartz |
| AI integration | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`) |
| Local DB | SQLite (`better-sqlite3`) |
| Build | electron-vite |

## Quick start

```bash
# Install dependencies
pnpm install

# Build the Swift CLI (macOS only, first run only)
sh scripts/build-ax.sh

# Dev mode
pnpm dev

# Production build
pnpm build
```

Then open **Settings** in the app and configure at least one AI provider (Anthropic / OpenAI / Google / OpenAI-compatible endpoint).

### Drive Dodompa from Claude (optional)

Dodompa exposes its task-management API as an MCP server at `http://127.0.0.1:19876/mcp` whenever the app is running, so you can run existing tasks — or create new ones — from Claude Code / Claude Desktop.

**Claude Code** (streamable HTTP):

```bash
claude mcp add --transport http dodompa http://127.0.0.1:19876/mcp
```

**Claude Desktop** (stdio bridge — because Desktop's custom-connector UI rejects plain `http://`):

```bash
pnpm -C mcp build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dodompa": {
      "command": "node",
      "args": ["/absolute/path/to/Dodompa/mcp/dist/stdio-bridge.js"]
    }
  }
}
```

Full details and tool reference: [AGENTS.md](AGENTS.md).

## Language

The UI supports English and Japanese. On first launch it picks the closer one to your OS locale (`ja-*` → Japanese, everything else → English); switch any time in **Settings → General → Language**.

LLM prompts themselves are always English (they perform best that way), but AI-generated user-facing text — task descriptions, error analyses, suggestions — follows your UI-language preference.

## Where to go next

- **[AGENTS.md](AGENTS.md)** — architecture, design philosophy, agent pipeline, debugging guide.
- **[docs/agent-reference.md](docs/agent-reference.md)** — I/O spec for every AI agent in the pipeline.
- **[src/main/knowledge/](src/main/knowledge/)** — app-specific automation knowledge injected into prompts at runtime. Consumed by `planningAgent`, `exploratoryPlanAgent`, and `codegenAgent` via `renderKnowledgeBlock()`.

## Contributing

Issues and PRs welcome. Windows support in particular is wide open and well-scoped — see [CONTRIBUTING.md](CONTRIBUTING.md) for the design sketch and where help lands fastest.

## License

MIT — see [LICENSE](LICENSE). Fork it, ship it.
