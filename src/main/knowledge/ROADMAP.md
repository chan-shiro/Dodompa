# Knowledge System Roadmap

Future direction (Phase 3 onward) for the app-specific knowledge system (`src/main/knowledge/`).

In Phase 1-2 (as of 2026-04-10), each app has exactly one `.md` file and matching is alias-exact-match only. At the end of Phase 2 we had `.md` files for 7 apps, but knowledge tends to duplicate across similar apps (Mail/Outlook, Slack/LINE, etc.). We want to lower the cost of adding a new app while also supporting unknown apps.

Recommended order of attack: **1 → 2 → 5**. Defer item 4 (embeddings) until we have 30+ files.

## Roadmap

### Priority 1 (★★★): pattern decomposition + composition (Phase 3 candidate)

- Add a `knowledge/patterns/` directory
  - Examples: `quick-switcher.md`, `clipboard-paste-ja.md`, `applescript-make-new.md`, `file-save-dialog.md`, `electron-shallow-ax.md`
- Add `patterns: [quick-switcher, electron-shallow-ax]` to the frontmatter of each `apps/*.md`
- Have `resolveKnowledge` also return the patterns of the matched app (dedupe via Set)
- **Benefit:** adding LINE becomes a 3-line change (name, bundleId, patterns). The same knowledge as Slack applies automatically.
- **Cost:** 1 day

### Priority 2 (★★): category fallback

- Even when no specific app matches, inject if the category matches
  - Example: an unknown Electron chat app → inject all knowledge for the `electron-messaging` category
- Reuse the existing `category` frontmatter field
- **Cost:** half a day

### Priority 3 (★★): expand dynamic probing in analyzingAgent

- `sdef` detection already exists (`analyzingAgent.ts` L421-)
- Additional probe ideas:
  - Parse `Info.plist` + `otool -L` to classify Electron/Qt/Cocoa/Catalyst
  - Use `mdls` for App Store category
  - AX element count (reuse the existing `isShallowTree`)
- Passing that fingerprint into `resolveKnowledge` reduces reliance on alias string matching
- **Cost:** 1-2 days. Can be done in parallel with the knowledge track.

### Priority 4 (★): feedback loop (a Dodompa-flavored direction I personally recommend)

- After each step executes, record `(detectedApp, usedPattern, success, errorKind)` in a ledger
- Existing `strategyLedger` + `verifyAgent` results can be reused, so the new implementation is small
- On the next `resolveKnowledge` call, re-rank patterns by historical success rate
- For new apps this yields self-learning: category fallback → only the successful patterns settle in

### Priority 5 (☆, deferred): embeddings / RAG

- Consider once knowledge files exceed 30
- Use a local embedding model or a bundled cache and do similarity search against a query built from the task description + detected app info
- **Downside:** explainability drops. Not the right time for this yet.

## Residual hardcoding as of Phase 2 (candidates for removal in Phase 3)

- The allowlist/denylist near `codegenAgent.ts` L951-960 → can be generated dynamically from the `category` / `appleScript` fields of each knowledge file
- The locale alias dictionary in `failureDiagnosis.ts` L188-216 (`'mail': 'メール'`, etc.) → can be generated from each knowledge file's `aliases`
- The bundleId → name inference at `windowMatchAgent.ts` L40 → can be generated from the `bundleIds` field
