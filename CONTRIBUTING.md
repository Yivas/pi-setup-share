# Contributing

Bug reports, focused proposals, documentation improvements, and pull requests are welcome. The native extension is distributed through GitHub Releases and the public npm package `pi-setup-share`.

For a bug, use the [bug report form](https://github.com/Yivas/pi-setup-share/issues/new?template=bug.yml). Include a commit, Node.js version, operating system, expected and observed behavior, and the smallest synthetic reproduction. For a proposal, use the [proposal form](https://github.com/Yivas/pi-setup-share/issues/new?template=proposal.yml) and explain the task it would enable.

Discuss substantial format or behavior changes before implementing them. Search existing issues first. Keep each pull request focused and explain its compatibility and security consequences.

## Local checks

Use Node.js 22.19.0 or newer and npm:

```sh
npm ci --ignore-scripts
npm run check
```

The development SDK and native TUI components are pinned to Pi 0.85.0. TypeScript checks project code and its use of SDK signatures, but `skipLibCheck` excludes dependency declaration internals: this Pi release has incompatible generated JSON imports and an unconditional type reference to an optional MCP peer. Do not add unused dependencies or edit upstream files to hide those defects.

The adapter test loads through Pi's declared CLI and native extension loader in a disposable environment, with startup networking disabled and no model calls. Direct Node import of Pi 0.85.0's SDK fails because its unbundled entrypoint refers to an undeclared server package; this extension does not use that entrypoint outside the native host. Recheck both declaration and native-loading behavior when updating the development SDK.

The extension test also registers the command in the native host and snapshots synthetic component output with Pi's theme at 80×24 and 120×40. The snapshots are regression fixtures, not evidence of a complete physical-terminal session. Update them deliberately with `node --test --test-update-snapshots test/extension.test.ts` only after reviewing the changed render. Flow tests exercise the real components and lifecycle in disposable directories with a fake package installer; they never install third-party packages.

Add a positive test and a relevant rejection or failure test when changing validation. Test data must be synthetic. Do not add runtime dependencies without explaining why the platform or an existing implementation is insufficient.

## Before submitting

- Remove real profiles, configuration, credentials, private endpoints, personal paths, sessions, and logs.
- State which checks you ran and which platforms you did not test.
- Update documentation if supported inputs, limits, errors, or behavior change.
- Confirm that you have the right to contribute any code or material under the repository's MIT license. Do not copy third-party setup resources into fixtures.

Do not report vulnerabilities publicly; use [SECURITY.md](SECURITY.md). Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Reviews are best effort, with no promised response time.
