# bantai

Open-source terminal UI for agentic coding backends. Decoupled from any single AI provider — works with Claude Code, Codex, ACP, and more.

## Install

```bash
bun install
bun link        # symlinks bantai into ~/.bun/bin (changes here are reflected immediately)
```

## Usage

```bash
bantai              # start the TUI
bantai --backend mock   # start with mock backend
```

## Development

```bash
bun run dev                 # run from source
bun run dev:mock            # run with mock backend
bun test                    # run all tests
bun run lint:opentui        # check OpenTUI prop rules
```

## Slack frontend

The Slack frontend lives in a separate repo: [bantai-slack](https://github.com/ohwxyz/bantai-slack). Install it alongside bantai and `bantai slack <cmd>` / `bantai minislack` will forward to its bin via commander's executable-subcommand convention.

## License

MIT
