# Vanguard Extension - Phase 1 + Phase 2 Spike

Vanguard is a deterministic VS Code extension foundation for a Visual Git + surgical mutation workflow.

## Phase 1 shipped

- AST-first JSX/TSX intelligence (Babel parser/traverse, no text heuristics)
- Fingerprint gatekeeper for `v-id`
  - Missing `v-id` detection
  - Duplicate `v-id` detection
  - Invalid `v-id` format detection (`vg_*`)
  - Drift detection against a local baseline
- Exact source mapping
  - Every valid `v-id` is mapped to line/column in file
- Local-first extension wiring
  - Real-time diagnostics on open/save/change
  - Commands for active-file validation, workspace scan, baseline refresh

## Phase 2 spike shipped

- Persistent sidecar preview webview (`Vanguard: Open Preview`)
- Visibility-gated WebContainer boot sequence
  - Only boots while panel is visible
  - Tears down process/container when hidden
- Project snapshot mounting into WebContainer
  - Excludes heavy folders (`node_modules`, `.next`, etc.)
  - Skips binary and oversized files with telemetry diagnostics
- Dev server orchestration in webview
  - Attempts `npm install` then `npm run dev`
  - Streams runtime logs to preview telemetry panel
- Bidirectional messaging bridge
  - Extension -> Webview:
    - file saved events
    - validator completion events
    - workspace scan completion events
  - Webview -> Extension:
    - boot failure diagnostics
    - DOM click messages with `v-id` (when same-origin frame access is available)
- Webview security hardening
  - nonce-based CSP
  - constrained `localResourceRoots`
  - explicit `connect-src` / `frame-src` allowlist

## Phase 3 shipped

- Selector bridge injection script in preview runtime
  - Global `mouseover`, `mousemove`, and capture-phase `click` listeners
  - Nearest-parent `[v-id]` extraction via `closest()`
  - Click sends `VANGUARD_SELECT` payload to extension bridge
- Sovereign selector overlay in webview (Shadow DOM)
  - High-contrast snap box (cyan + red flash on select)
  - Non-destructive, `pointer-events: none`
  - Tooltip renders `<tag> v-id`
- Editor sync payoff
  - `VANGUARD_SELECT` resolves through AST-derived `v-id` index
  - Opens source file and reveals exact mapped JSX attribute position
- Cross-origin fallback contract
  - If direct iframe injection is blocked, runtime emits `VANGUARD_BRIDGE_INJECT` to frame
  - Target app can listen and execute provided script to arm selector bridge

## Phase 4 shipped

- Floating Mutation Input in preview webview
  - Appears after a `v-id` selection
  - Sends natural language mutation prompt to extension
- Surgical context packer
  - Extracts target JSX node source by `v-id`
  - Includes parent + sibling JSX snippets
  - Includes Tailwind config context (`tailwind.config.*`, `postcss.config.js`, `package.json`)
- DeepSeek mutation caller + deterministic router
  - `fast-stream` path for CSS/Tailwind prompts
  - `reasoning-heavy` path for logic-sensitive prompts
  - Strict JSON contract: `{"updatedJsx":"...","notes":"..."}`
- Deterministic patcher
  - Applies replacement only at target AST range (never full-file overwrite)
  - Runs Phase 1 gatekeeper on patched output
  - Auto-retries up to 3 attempts when patch is invalid
- History integration
  - Mutation changes are staged and committed with `isomorphic-git` when repo is available
  - Gracefully skips commit if no repository is detected

## Commands

- `Vanguard: Validate Active File`
- `Vanguard: Scan Workspace`
- `Vanguard: Refresh Fingerprint Baseline`
- `Vanguard: Open Preview`

## Baseline file

Baseline is written per workspace to:

`.vanguard/v-id-baseline.json`

Use refresh only when intentionally accepting the current tree as the canonical identity state.

## Required environment

Set these in your extension host environment:

- `OPENROUTER_API_KEY` (required)
- `VANGUARD_GIT_AUTHOR_NAME` (optional)
- `VANGUARD_GIT_AUTHOR_EMAIL` (optional)

## Dev

```bash
npm install
npm run build
```
