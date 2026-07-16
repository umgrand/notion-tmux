# notion-tmux

A lightweight CLI that watches a Notion database and streams each ticket's
coding-agent run into its own tmux window. Move a ticket to your trigger
status in Notion, and `notion-tmux` picks it up, kicks off a coding agent
against your repo, and opens a live tmux window so you can watch the run as
it happens.

## Quickstart

```bash
git clone <repo> && cd notion-tmux
npm run setup
```

`npm run setup` installs dependencies, builds the workspace, links the
`notion-tmux` command onto your `PATH`, and walks you through an interactive
scaffold that writes `.env` and `projects.json` into a run directory of your
choice (default `~/notion-tmux-run`).

Once setup finishes:

```bash
cd ~/notion-tmux-run && notion-tmux watch
```

In another terminal, watch the ticket windows as they open:

```bash
tmux attach -t notion-tmux
```

Move a Notion ticket into your configured trigger status (e.g. "Ready for
Dev") and a new tmux window opens streaming that ticket's run.

## Prerequisites

- macOS + [Homebrew](https://brew.sh) (used to install `tmux` if it's missing)
- Node.js 20.19+
- git
- An authenticated coding-agent CLI — either `claude` (Claude Code) or `codex`
- A Notion integration token, with the target database shared to that
  integration

Run `npm run doctor -w @notion-tmux/ticket-engine` at any point to check that
your environment (tmux, agent CLI, Notion access) is set up correctly.

## Configuration

Configuration lives in the run directory you chose during setup — not in the
repo itself:

- `.env` — your Notion integration token, default agent, and polling settings
- `projects.json` — the list of projects (repo path, Notion database ID,
  status names, verify commands, etc.) that `notion-tmux` watches

See `packages/ticket-engine/.env.example` and
`packages/ticket-engine/projects.example.json` for the full shape of each
file. Re-run `npm run setup` any time to add or update a project.

## Development

This is an npm workspace with two packages:

- `packages/shared` — shared config types and schema validation
- `packages/ticket-engine` — the Notion polling engine and the `notion-tmux`
  CLI (`watch`, `attach`, `doctor`, `start`, `run-once`)

```bash
npm install
npm run build
npm test
npm run typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
