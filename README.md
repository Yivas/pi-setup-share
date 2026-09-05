# pi-setup-share

A Pi extension in development for sharing selected setup resources without copying an entire user directory.

**Not installable yet.** The current code validates a draft resource-profile format. Export, import, preferences, MCP/subagent configuration adapters, backups, and the `/setup-share` assistant are not implemented.

[Try the validator](#development) · [Security](SECURITY.md) · [Contribute](CONTRIBUTING.md)

## Current functionality

- Validate an explicit, versioned JSON envelope with selected text or binary resources.
- Reject unsupported fields, malformed contents, non-portable paths, and conflicting destinations.
- Bound JSON size, nesting, resource count, and decoded content size.

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

## Participation and rights

This is a collaborative open-source project under the [MIT license](LICENSE). Issues and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through the private channel in [SECURITY.md](SECURITY.md), not public issues. Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

The license covers this repository's code, documentation, and synthetic examples. It does not grant rights to third-party resources or configurations someone may later share with the tool.
