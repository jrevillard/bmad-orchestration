# BMad Orchestration

Two Skills-as-modules skills under the module key `bmad-orchestration`:

| Skill | Role |
|---|---|
| `/bmad-prd-orchestrate` | PRD meta-orchestrator: drives all stories across all epics with quality-gate convergence + CI + auto-merge |
| `/bmad-build-converge` | Single-story build + convergence loop + CI-fix + auto-merge (sub-workflow of the orchestrator; usable standalone) |

Both skills ship self-contained: the workflow `.js` plus the helper bash scripts (`write-state.sh`, `orchestrate-helper.sh`, `ci-monitor.sh`) live in each skill's `scripts/` folder. Claude Code's Workflow tool reads the JS and dispatches with the `script` parameter; helper paths are passed via `args.helpersDir` so the JS finds them at runtime regardless of install location.

## Install

In a project that already has BMad set up:

```bash
npx skills add github:jrevillard/bmad-orchestration
```

Installs both skills under `.agents/skills/` (symlinked into Claude Code's skill discovery).

For local development against this repo:

```bash
npx skills add /absolute/path/to/bmad-orchestration
```

After install, two slash commands become available: `/bmad-prd-orchestrate` and `/bmad-build-converge`.

## Prerequisites (consumer project)

The orchestration skills have **no hard BMM floor** — they only require that `_bmad/custom/issue-tracking.yaml` exists in the consumer. That file is created by the `bmad-issue-tracking-setup` skill, so the effective compat tracks whichever version of that module the consumer has installed:

- `bmad-issue-tracking` v2.x → writes the YAML on BMM 6.11+ (legacy `_bmad/{bmm,bmb,...}/` layout)
- `bmad-issue-tracking` v3.x → writes the YAML on BMM 6.12+ (flat `_bmad/{method,toolbox}/` layout)

Install `bmad-issue-tracking` first (v2.x for BMM 6.11, v3.x for BMM 6.12+), then install these orchestration skills.

Other upstream BMad skills required at runtime:
- `bmad-sprint-planning` (orchestrator-only) — for `sprint_plan.py generate --set <key>=done`
- `bmad-build-auto` (both) — the dev primitive
- `bmad-retrospective` (orchestrator, with `--retro`) — per-epic retro trigger

CLI: `glab` (GitLab) authenticated against the configured host.

## Layout

```
bmad-orchestration/
├── README.md
├── .gitignore
└── skills/
    ├── bmad-prd-orchestrate/
    │   ├── SKILL.md
    │   ├── module-manifest.toml
    │   ├── references/help.md
    │   └── scripts/
    │       ├── bmad-prd-orchestrate.js
    │       ├── write-state.sh
    │       ├── orchestrate-helper.sh
    │       └── ci-monitor.sh
    └── bmad-build-converge/
        ├── SKILL.md
        ├── module-manifest.toml
        ├── references/help.md
        └── scripts/
            ├── bmad-build-converge.js
            ├── write-state.sh
            ├── orchestrate-helper.sh
            └── ci-monitor.sh
```

## Versioning

Module key: `bmad-orchestration`. Version: `1.0.0` for the initial release. Both skills in this module declare the same version.

Until a `v1.0.0` git tag exists on this repo, `bmad setup --doctor` will report the module as `blocked` (can't compare against a tagged release). The install itself is healthy — only the release comparability check fails.

## License

Same license as upstream BMad (MIT).
