# pi-setup-share

A Pi extension in development for sharing selected setup resources without copying an entire user directory.

**Not installable yet.** The current code validates a draft profile format and projects selected preferences and keybindings. File export/import, MCP/subagent configuration adapters, backups, and the `/setup-share` assistant are not implemented.

[Try the validator](#development) · [Security](SECURITY.md) · [Contribute](CONTRIBUTING.md)

## Current functionality

- Validate an explicit, versioned JSON envelope with selected text or binary resources.
- Reject unsupported fields, malformed contents, non-portable paths, and conflicting destinations.
- Bound JSON size, nesting, resource count, and decoded content size.
- Project explicitly selected preferences and namespaced keybindings without copying execution settings, trust, telemetry, or host defaults.

Validation does not execute resource content or access the filesystem or network. It does **not** detect every secret, authenticate a sender, or make imported code and prompts trustworthy. Use synthetic data for development; do not submit real profiles or configuration in issues or pull requests.

## Development

Requires Node.js 22.19.0 or newer and npm. There is no published package or stable format contract.

```sh
git clone https://github.com/Yivas/pi-setup-share.git
cd pi-setup-share
npm ci --ignore-scripts
npm run check
```

`npm run check` runs TypeScript checking and the Node.js test suite. Node's type stripping alone does not check types. CI is configured for Windows, macOS, and Linux on Node 22.19.0 and 24; see [actual workflow results](https://github.com/Yivas/pi-setup-share/actions/workflows/ci.yml) for verification.

## Draft resource format

This synthetic example contains a prompt as data, not an instruction to execute:

```json
{
  "format": "pi-setup-share",
  "version": 1,
  "resources": [
    {
      "kind": "prompt",
      "path": "example.md",
      "encoding": "utf8",
      "content": "Synthetic example"
    }
  ]
}
```

[`parseProfile(text)`](src/profile.ts) bounds the input before JSON parsing, then validates it. `validateProfile(value)` validates an already parsed JSON value and returns copied resource records. Failures are `ProfileError` instances with a machine-readable `code` and `field`; imported values are not included in error messages.

Resource kinds are `extension`, `skill`, `prompt`, `theme`, and `agent`. They identify separate destination namespaces; they do not authorize loading anything. Content uses lossless `utf8` or canonical padded `base64`. The format is under development and may change before the first release.

Limits: 16 MiB serialized JSON, nesting depth 8, 256 resources, 1 MiB decoded per resource, and 8 MiB decoded total. Paths must be relative and NFC-normalized, at most 240 UTF-8 bytes overall and 100 per segment. Leading/trailing dots or spaces, Windows device names, control characters, traversal, and case-folded file/directory collisions are rejected. These lexical checks are not filesystem containment or symlink protection; there is no file writer yet.

Optional `preferences` and `keybindings` fields are accepted. [`projectPreferences(selected)`](src/preferences.ts) and [`projectKeybindings(selected)`](src/keybindings.ts) copy supported selections and return diagnostics for omissions; they do not discover or read your configuration. Strict profile validation rejects unsupported fields instead of silently dropping them. Unknown names and values are not included in diagnostics. Invalid record shapes fail validation.

Preferences cover bounded display, thinking, compaction, branch-summary, image, and message-delivery settings. Theme names are limited to `dark` and `light`; model/provider identifiers require explicit review and restricted identifier syntax, not arbitrary text. Token limits are integers from 0 to 1,000,000; these are profile limits, not Pi's own validation guarantees. Code indentation is 0–32 spaces. See the [allowlist](src/preferences.ts) for exact fields and bounds. Shell commands, resource paths, networking, trust, tools, telemetry, and per-model maps are excluded.

Keybindings use Pi 0.85.0 namespaced built-in action IDs. Missing bindings preserve host defaults; `[]` deliberately disables that action's shortcuts. Each action allows at most 16 keys, each at most 64 characters. Duplicate modifier/alias combinations within an action are rejected. Shared keys across actions produce a projection warning because different contexts can legitimately share shortcuts. Terminal support and contextual conflicts still need receiver review; this is not a keyboard-compatibility guarantee. Literal `+` keys and modified F1–F12 keys are unsupported by this draft because Pi 0.85.0 cannot match those bindings. Only the stable `regular` TUI mode is included in preferences.

## Participation and rights

This is a collaborative open-source project under the [MIT license](LICENSE). Issues and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through the private channel in [SECURITY.md](SECURITY.md), not public issues. Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

The license covers this repository's code, documentation, and synthetic examples. It does not grant rights to third-party resources or configurations someone may later share with the tool.
