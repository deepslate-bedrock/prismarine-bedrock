# Agent Workflow

This repo is the clean base library for `prismarine-bedrock`. Keep changes focused on reusable source, examples, library docs, and tests.

## Start Every Task

1. Run `git status --short` and treat existing changes as user or peer-agent work.
2. Read the relevant source and tests before editing.
3. For test changes, read `test/rules.md`.
4. Keep runtime/debug artifacts in `logs/` or `scripts/tmp/`; both are gitignored.

## Context Budget

- Pull context sparsely: use `rg`, `rg --files`, `git diff --stat`, and focused file ranges before opening full files.
- Read the nearest source, tests, and rule sections needed for the current change. Avoid loading broad docs, generated data, or old task history unless the next decision depends on it.
- Keep handoff notes concise: changed files, focused commands run, current failure or uncertainty, and the next exact file/command to inspect.
- When another agent is involved, assign a narrow owned path or question and ask for concise findings plus changed paths.

## Repository Boundaries

- Base library work belongs here: `src/`, `examples/`, `test/static/`, `test/fake-world/`, `test/live/`, and library reference docs.
- Agent workflow, packet parity task logs, recorded BDS scenarios, Endstone packet recording, e2e server launchers, and trace comparison tooling belong in [`prismarine-bedrock-ai`](https://github.com/deepslate-bedrock/prismarine-bedrock-ai).
- Use [`prismarine-bedrock-workspace`](https://github.com/deepslate-bedrock/prismarine-bedrock-workspace) when a task needs both repos checked out together.

## Testing

- Static tests: `pnpm run test:static`
- Fake-world tests: `pnpm run test:fake-world`
- Live tests against an already-running server: `pnpm run test:live`
- Default tests: `pnpm test`

## Protocol Notes

Use `src/version.js` for the default Bedrock protocol version and helpers. The default client/protocol version is `1.26.10`; shorthand `26.10` is normalized to `1.26.10`.

Use the installed `minecraft-data` Bedrock files under `node_modules/minecraft-data/minecraft-data/data/bedrock/<MC_VERSION>/` for exact packet shapes. When this repo is checked out through `prismarine-bedrock-workspace`, shared reference checkouts may also be available under the workspace root `ref/` directory:

- `ref/minecraft-data/`: upstream data source history.
- `ref/bedrock-protocol-docs/`: Mojang Bedrock protocol field semantics.
- `ref/gophertunnel/`: Bedrock protocol implementation context.
- `ref/geyser/`: Java/Bedrock translation behavior.
- `ref/boar/`: Geyser Bedrock-player prediction and movement reference.

Treat `ref/` checkouts as inspection-only external sources. Do not copy source from them into this library as a substitute for verifying the installed serializer schema and local tests.

Before testing new packet send/receive shapes against a server, round-trip representative packets with `scripts/roundtrip-packet.js` when applicable.
