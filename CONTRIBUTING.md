# Contributing to Dodompa

> 🇯🇵 日本語版: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)

Thanks for taking a look. Dodompa is MIT-licensed and developed in the open — issues, PRs, and design discussions are all welcome.

This doc is intentionally thin. Architecture, design philosophy, and agent internals live in [AGENTS.md](AGENTS.md) — read that before a non-trivial change.

## Getting set up

```bash
# Clone
git clone <your-fork-url> Dodompa
cd Dodompa

# Install deps
pnpm install

# Build the Swift CLI (macOS only, first time)
sh scripts/build-ax.sh

# Dev mode
pnpm dev

# Production build
pnpm build
```

Then open **Settings** in the app and configure one AI provider (Anthropic / OpenAI / Google / OpenAI-compatible). Without that, task generation will fail.

Further reading:
- [AGENTS.md](AGENTS.md) — architecture, agent pipeline, debugging guide
- [docs/agent-reference.md](docs/agent-reference.md) — I/O spec for every AI agent

## Where help is especially welcome

### 1. Windows support (big, well-scoped)

**Status:** placeholder only. `src/main/desktop/win/index.ts` currently throws "not yet implemented".

macOS desktop automation is implemented as:
- `native/macos/dodompa-ax/` — a small Swift CLI that exposes subcommands (`list-windows`, `tree`, `find`, `element-at`, `perform-action`, `click`, `right-click`, `move`, `drag`) over the Accessibility API. Output is JSON.
- `src/main/desktop/mac/` — TypeScript wrappers that `execFile` the CLI (`axBridge.ts`, `keyboard.ts`, `mouse.ts`, `screenshot.ts`, `index.ts`).
- `src/main/desktop/platform.ts` — factory dispatching on `process.platform`.

**A Windows port mirrors this shape:**
1. **Native CLI at `native/windows/dodompa-ax/`.** Recommended stack: **C# + .NET 8** — UIAutomation (`System.Windows.Automation`) maps cleanly onto the same subcommands, build is one `dotnet publish -c Release -r win-x64 --self-contained` step, binaries are easy to ship. C++ with the COM UIAutomation API works too but is heavier to maintain. Expected JSON output shape should match the Swift CLI's — see `DesktopContext` in [src/shared/types.ts](src/shared/types.ts) for the `WindowInfo` / `AXNode` schemas.
2. **TypeScript wrapper at `src/main/desktop/win/`.** Mirror `src/main/desktop/mac/` — an `axBridge.ts` that execs the CLI, and `keyboard.ts` / `mouse.ts` / `screenshot.ts` using Win32 `SendInput` + GDI / Desktop Duplication. If you prefer a Node-native approach for input, `@nut-tree/nut-js` is a reasonable dependency, but please keep the CLI-based AX path — it keeps the architecture consistent across platforms.
3. **Platform wiring.** Update `isDesktopSupported()` in `src/main/desktop/platform.ts` to include `win32`, and add a `scripts/build-ax.ps1` (or equivalent) so `pnpm install && build-ax` bootstrap works on Windows.
4. **Packaging.** Update `electron-builder` config (will need to be added) so the Windows binary ships in `resources/bin/`.

Things that **won't** port directly:
- AppleScript — no direct analog. Windows apps rarely expose scriptable interfaces. The fallback path should be "use UIAutomation for everything" and skip the AppleScript branch. Grep for `sdef` / `osascript` usage in `src/main/ipc/agents/` to see where those branches exist — they're guarded by platform checks, but the planning prompts should be updated so Windows runs don't suggest AppleScript.
- Bundle IDs — map to `ProcessModuleFileName` (full executable path). The `bundleIds` field in `src/main/knowledge/apps/*.md` won't match; consider adding an equivalent `executables:` frontmatter field and updating `resolveKnowledge()` in [src/main/knowledge/index.ts](src/main/knowledge/index.ts).

Happy to pair-design over an issue — file one labeled `platform:windows` with your planned stack and we can sort out the open questions before you write code.

### 2. Linux support

Same shape as Windows: would use AT-SPI via `python-atspi` or a small Rust/Go CLI exposing the same subcommand contract. Lower priority than Windows — open an issue if you're interested.

### 3. App-specific knowledge files (great first PR)

Per-app prompt knowledge lives under [src/main/knowledge/apps/](src/main/knowledge/apps/) as Markdown with YAML frontmatter. Adding support for a new app (LINE, Discord, Spotify, Bear, Obsidian, …) is usually 20-100 lines of markdown and gets exercised immediately by the planning / codegen agents.

Read existing files under `apps/` for shape. Frontmatter reference is in [src/main/knowledge/index.ts](src/main/knowledge/index.ts) (`KnowledgeFrontmatter`). This is the cheapest way to have user-visible impact.

### 4. Test coverage

Current test coverage is light. Deterministic playback of generated step files against a known HTML fixture or a mock AX tree would be very welcome. If you want to set up a test harness, please open an issue first so we can align on scope.

### 5. Translations

UI strings are in i18next (`src/shared/i18n/` and related renderer files). English and Japanese are currently supported. Other locales welcome — PR a new resource file and wire it into the detector.

## PR conventions

- **One concern per PR.** A Windows AX CLI + a refactor of the planning prompt in the same PR is hard to review.
- **Commit messages:** short imperative subject line, body explaining *why* when the change isn't obvious.
- **Don't edit generated `step_*.ts` files** to fix runtime bugs — improve the agent that generated them. See [AGENTS.md](AGENTS.md) § "Debugging / fixing tasks".
- **No unsolicited reformatting.** If you want to change project style, open an issue first.
- **Type-check before pushing:** `pnpm build` should succeed. (There are pre-existing type errors in some agent files under `src/main/ipc/agents/`; don't worry about those unless you're working in that area.)

## Issues & discussions

- **Bugs** — reproduction steps, expected vs actual, OS/model provider.
- **Feature requests** — describe the workflow first, implementation second.
- **Design questions** — larger changes (new agent, schema change, platform port) should start as an issue so we can align before you write code.

## License

By submitting a PR you agree your contribution is released under the [MIT License](LICENSE). No CLA.
