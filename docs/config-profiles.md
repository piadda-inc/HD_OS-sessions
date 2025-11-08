## Config Profiles

The `sessions/config/profiles` directory captures every configuration that used to live in the scattered `sessions` copies across the workspace. Instead of cloning and editing multiple frameworks, pick the profile that matches your workflow and copy it into `sessions/sessions-config.json`.

### How to apply a profile

1. Pick a profile file from `config/profiles`.
2. `cp sessions/config/profiles/<profile>.json sessions/sessions-config.json`
3. Edit the copy in place (developer name, blocked commands, etc.).

The repo never edits the files under `config/profiles` directly—treat them as golden references so we can diff local tweaks against the known defaults.

### Available profiles

- `adrian.json` – Default profile used in this workspace (implementation triggers, strict branch enforcement, meta-learning disabled).
- `developer-backlog.json` – Backlog automation constraints (discussion mode SILENCE, auto-merge on, backlog/python read blocks).
- `loko-core.json` – Loko’s zsh workflow with dual implementation phrases and emoji statusline output.
- `actions-contract.json` – Hybrid Node/Python action-contract stack that blocks direct Python execution and enables uninstall safeguards.
- `graphiti-memory-stack.json` – Graphiti meta-learning pilot with auto-merge/push enabled and read restrictions for stability.

Add new profiles by dropping another JSON file in `config/profiles` and documenting it here.
