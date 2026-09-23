# pi-setup-share

Share selected Pi settings and resources through a native `/setup-share` assistant, without copying an entire user directory.

**Version 0.3.0 — selective global resource inventory and v2 transfer reports.** Update both sender and receiver before sharing a v2 profile: version 0.2.0 cannot read it. Start with synthetic data: validation does not make imported code trustworthy, and isolated package storage is not a sandbox.

[Use in Pi](#use-in-pi) · [Changes](CHANGELOG.md) · [Development](#development) · [Security](SECURITY.md) · [Contribute](CONTRIBUTING.md)

## Functionality in this checkout

- Validate a v2 JSON profile and sender report inside a one-entry ZIP, while still accepting v1 ZIP and plain JSON profiles.
- Reject unsupported fields, malformed contents, non-portable paths, and conflicting destinations.
- Bound JSON size, nesting, resource count, and decoded content size.
- Project explicitly selected preferences and namespaced keybindings without copying execution settings, trust, telemetry, or host defaults.
- Inventory names from known global Pi and user-agent resource locations, then read only selected text/binary files with bounded reads, link rejection, cancellation, and file-change checks.
- Project inactive MCP definitions, minimal subagent settings, and pinned package descriptors without connecting or installing.
- Serialize explicit selections and preview configuration conflicts without filesystem effects.
- Back up, apply, restore, and recover bounded managed-file transactions with consent and change checks.
- Install pinned packages into a per-import directory through Pi's package manager, then separately activate local references.

Validation does not execute resource content or access the filesystem or network. It does **not** detect every secret, authenticate a sender, or make imported code and prompts trustworthy. Use synthetic data for development; do not submit real profiles or configuration in issues or pull requests.

## Development

Requires Node.js 22.19.0 or newer and npm. The profile format remains a development draft.

```sh
git clone https://github.com/Yivas/pi-setup-share.git
cd pi-setup-share
npm ci --ignore-scripts
npm run check
```

`npm run check` runs TypeScript checking and the Node.js test suite. Node's type stripping alone does not check types. CI is configured for Windows, macOS, and Linux on Node 22.19.0 and 24; see [actual workflow results](https://github.com/Yivas/pi-setup-share/actions/workflows/ci.yml) for verification of each commit. The local synthetic checks do not establish that a specific MCP server or third-party package works on another machine.

## Use in Pi

Use Pi 0.85.0. Version 0.3.0 adds global resource inventory and v2 reports. To use a development checkout, load `./src/index.ts` from this directory in an isolated Pi instance. To install the versioned package:

```sh
pi install npm:pi-setup-share@0.3.0
```

Restart Pi, then enter `/setup-share`. New exports are standard ZIP archives containing exactly `profile.json`; inspection and import also accept plain JSON profiles created by 0.1.x.

To try the package for one interactive session without adding it to global settings, run:

```sh
pi -e npm:pi-setup-share@0.3.0
```

You can also work from a checkout or extract the source archive from [GitHub Releases](https://github.com/Yivas/pi-setup-share/releases). From the package directory, load the extension directly with:

```sh
pi --no-session --no-context-files --no-extensions -e ./src/index.ts
```

The command uses Pi's native theme and keyboard controls; it does not require a model request. It is TUI-only, not an RPC or print-mode tool. The tested component sizes are 80×24 and 120×40.

For a disposable first run of the development checkout, isolate both Pi's agent directory and the home directory used for `.agents` discovery. On macOS/Linux:

```sh
TEMP_HOME="$(mktemp -d)"
mkdir "$TEMP_HOME/pi"
HOME="$TEMP_HOME" PI_CODING_AGENT_DIR="$TEMP_HOME/pi" pi --no-session --no-context-files --no-extensions -e ./src/index.ts
```

On PowerShell:

```powershell
$previousAgent = $env:PI_CODING_AGENT_DIR
$previousHome = $env:USERPROFILE
try {
    $temporaryHome = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    $env:USERPROFILE = $temporaryHome
    $env:PI_CODING_AGENT_DIR = Join-Path $temporaryHome 'pi'
    New-Item -ItemType Directory $env:PI_CODING_AGENT_DIR -Force | Out-Null
    pi --no-session --no-context-files --no-extensions -e ./src/index.ts
} finally {
    $env:PI_CODING_AGENT_DIR = $previousAgent
    $env:USERPROFILE = $previousHome
}
```

The temporary directory is retained for inspection. Do not delete it while an operation is running.

- **Export:** choose global categories, then individual items. Everything starts unchecked. MCP selection includes **Select all portable MCP servers**; nonportable servers are named locally with a safe reason but are not copied. Only `settings.json`, `keybindings.json`, or `mcp.json` for a chosen category is read; project settings are never merged. You can inventory extensions, skills, prompts, themes, and agents in the global Pi directory and `~/.agents` locations, select candidates and support files, resolve duplicate names by source, and optionally add files from an explicit root. The scanner looks at names only; selected files are read after selection. No directory is copied wholesale. Review the selected values, inventory gaps, and safe omission counts before confirming a new ZIP.
- **Inspect:** read a chosen profile ZIP or legacy JSON and show configuration/resource metadata and any sender-supplied report without staging, installing, extracting files, or loading it. The report does not prove completeness or safety. Executable resource contents are not displayed; review those in the original file before trusting them.
- **Import:** select incoming items, review, then separately confirm staging, installation, and activation. **Later** leaves the import inactive and resumable. If packages are present, installation must finish before this assistant offers activation.
- **Resume:** choose a saved import by ID, verified phase, resource/package counts, and next action. An incomplete package attempt requires a fresh import; it is never retried or cleaned up automatically.
- **Restore:** reverse this import's managed file changes without overwriting later edits. Installed files, running code, and script effects remain. Reload or restart Pi afterward.
- **Recover:** repair interrupted managed changes. Removing a stale lock requires an additional confirmation that the other operation has stopped.

Activation writes global settings and references. Some consumers may react immediately; use `/reload` deliberately when ready to load other resources. The assistant never reloads automatically. Cancellation waits for in-flight work to settle; it does not undo earlier confirmed steps or external script effects.

Profile paths must be absolute, local filesystem paths without shell quoting. Existing outputs are never overwritten, including concurrent exports. Links, nonregular files, known operational roots/names, and invalid UTF-8 are rejected. An interrupted export can leave a complete or incomplete file; use a new filename to retry. Import discovery bounds directory entries to 4,096 and available manifests to 128; each selected status revalidates its manifest, profile, staged files, and installed paths.

The assistant does not send profiles or target configuration to models, session entries, telemetry, or external services. Package installation is the separately consented network/execution boundary. Terminal content remains subject to any terminal recording or other extensions you have enabled.

## Draft resource format

A 0.3.0 export contains one file named `profile.json` with interior version 2 and a bounded `transfer` report. The 0.2.0 reader rejects version 2; 0.3.0 reads both versions 1 and 2, including legacy plain JSON. The ZIP transport still contains only one member. This synthetic example contains a prompt as data, not an instruction to execute:

```json
{
  "format": "pi-setup-share",
  "version": 2,
  "resources": [
    {
      "kind": "prompt",
      "path": "example.md",
      "encoding": "utf8",
      "content": "Synthetic example"
    }
  ],
  "transfer": {
    "scanned": ["prompt"],
    "partial": [],
    "notExamined": ["project"],
    "omissions": [{ "category": "prompt", "reason": "unselected", "count": 1 }],
    "actions": ["review-resources", "review-omissions"]
  }
}
```

[`parseProfile(text)`](src/profile.ts) bounds the input before JSON parsing, then validates it. `validateProfile(value)` validates an already parsed JSON value and returns copied resource records. Failures are `ProfileError` instances with a machine-readable `code` and `field`; imported values are not included in error messages.

The report contains only known category/reason/action codes and bounded counts, never names or values of excluded files. It describes the sender's inventory before the recipient selects items, not the complete contents of either computer. Unknown settings, project resources, standalone Markdown skills, external tools and file locations outside the known roots are not inventoried. Candidate counts are capped at 256, each root scan examines up to 1,024 entries, checks a cooperative five-second budget, and nested discovery stops after four levels. A limit is reported as partial coverage; an in-flight filesystem call cannot be interrupted by the clock check. The receiver still needs to configure accounts and environment values, install tools, check endpoints and models, and review code, licenses and omissions. No preview installs or activates anything.

Resource kinds are `extension`, `skill`, `prompt`, `theme`, and `agent`. They identify separate destination namespaces; they do not authorize loading anything. Content uses lossless `utf8` or canonical padded `base64`. The format is under development and may change in future releases.

Archive limits: 17 MiB ZIP, exactly one regular entry named `profile.json`, and 16 MiB after decompression. Entries with another name, additional entries, directories, encryption, comments, inconsistent sizes, invalid CRC, or unsupported structure are rejected; nothing is extracted to disk. JSON limits remain 16 MiB serialized JSON, nesting depth 8, 256 resources, 1 MiB decoded per resource, and 8 MiB decoded total. Paths must be relative and NFC-normalized, at most 240 UTF-8 bytes overall and 100 per segment. Leading/trailing dots or spaces, Windows device names, control characters, traversal, and case-folded file/directory collisions are rejected. These lexical checks are not filesystem containment or symlink protection; filesystem operations apply separate checks.

Optional `preferences` and `keybindings` fields are accepted. [`projectPreferences(selected)`](src/preferences.ts) and [`projectKeybindings(selected)`](src/keybindings.ts) copy supported selections and return diagnostics for omissions; they do not discover or read your configuration. Strict profile validation rejects unsupported fields instead of silently dropping them. Unknown names and values are not included in diagnostics. Invalid record shapes fail validation.

Preferences cover bounded display, thinking, compaction, branch-summary, image, and message-delivery settings. Theme names are limited to `dark` and `light`; model/provider identifiers require explicit review and restricted identifier syntax, not arbitrary text. Token limits are integers from 0 to 1,000,000; these are profile limits, not Pi's own validation guarantees. Code indentation is 0–32 spaces. See the [allowlist](src/preferences.ts) for exact fields and bounds. Shell commands, resource paths, networking, trust, tools, telemetry, and per-model maps are excluded.

Keybindings use Pi 0.85.0 namespaced built-in action IDs. Missing bindings preserve host defaults; `[]` deliberately disables that action's shortcuts. Each action allows at most 16 keys, each at most 64 characters. Duplicate modifier/alias combinations within an action are rejected. Shared keys across actions produce a projection warning because different contexts can legitimately share shortcuts. Terminal support and contextual conflicts still need receiver review; this is not a keyboard-compatibility guarantee. Literal `+` keys and modified F1–F12 keys are unsupported by this draft because Pi 0.85.0 cannot match those bindings. Only the stable `regular` TUI mode is included in preferences.

[`exportResources(root, selection, signal?)`](src/files.ts) reads only explicitly listed `{kind, path}` entries beneath an absolute root chosen by the caller; it does not scan folders or write a profile. It rejects symlink/junction descendants, linked roots, hardlinked files, and known operational filenames such as `auth.json`, `.env`, `.npmrc`, `settings.json`, and `trust.json`. The chosen root and its canonical ancestors cannot be known operational locations such as `sessions`, `.ssh` or `node_modules`; session/history/log directories and `.log`/`.jsonl` files are excluded. Structured configuration must go through its dedicated projection rather than a resource copy. These filename exclusions cannot detect secrets in arbitrary resource content.

Reads check identity, size, and timestamps before and after, and enforce both decoded and serialized size limits. The root is canonicalized, so OS-managed ancestor aliases can resolve normally. This is not an atomic snapshot or protection against a hostile process racing filesystem changes or a filesystem providing unreliable metadata. Filesystem errors expose a code and selection index, not local paths. The operation fails rather than returning an incomplete selection.

Optional `integrations` accepts `mcpServers` and `subagents`. Projection contracts target `pi-mcp-adapter` 2.26.0 and `pi-subagents` 0.50.0; end-to-end behavior with those adapters is not verified yet. The [MCP projection](src/integrations.ts) always emits literal `disabled: true` and `approveTools: true`, regardless of the sender's settings. It accepts executable names without paths or HTTPS URLs without credentials, query parameters, or fragments. IP literals and common local/reserved host suffixes are excluded; this is only a syntax check, not proof of public DNS or endpoint ownership. There are no DNS requests. Review every endpoint before sharing or enabling it.

MCP environment requirements contain names only. Environment values, headers, OAuth configuration, credential commands, sockets, working directories, debugging, and other unlisted fields are not transferred. Arguments are bounded and checked for recognizable absolute/home paths (direct or common-option forms), URLs, and obvious secret-related text. These heuristics cannot prove portability or find paths/secrets inside arbitrary argument languages or resource content; review both before sharing or executing. Missing authentication must be configured locally before activation. Subagent projections include only `defaultModel`, `defaultThinking`, `disableThinking`, and `disableBuiltins`, not overrides, extension paths, schedules, or operational state.

Optional `packages` contains [pinned descriptors](src/packages.ts): exact npm SemVer versions or HTTPS Git URLs with a full 40-hex commit. Floating versions, branches, local paths, and credentials are rejected. Pins do not authenticate content or establish redistribution rights. Basic relative filters support `*`, `?`, and leading `!`, `+`, or `-`; complex brace, character-class, and extglob expansions are excluded. Missing filters and `[]` remain distinct. `autoload: false` is a resource filter, **not** an installation barrier or sandbox. Installing packages can run third-party scripts and requires separate consent from activating resources.

## Export and transaction core

[`exportProfile(selection)`](src/export.ts) composes explicit selections and returns a copied profile, bounded JSON text, and omission diagnostics. It does not discover configuration or write the resulting file. Optional `entrypoints` maps resource kinds to selected UTF-8 paths. Support files are never inferred as entrypoints; declaring an entrypoint does not load or activate it.

[`previewConfiguration(profile, target, decisions)`](src/preview.ts) is pure: it preserves existing values by default and requires explicit overwrite decisions for conflicts. Each decision is evaluated against the original target. MCP environment placeholders remain unresolved and imported servers remain disabled. The returned configuration can contain preserved local data: do not export it or send it to a model, log, or external service. Only the item metadata is intended for a review summary.

[`FileStore`](src/storage.ts) and the [transaction core](src/transaction.ts) are low-level APIs for trusted callers, not a complete import workflow. They use bounded snapshots, link rejection, exclusive temporary files, file synchronization, and change checks before replacement. Transactions restrict destinations, require literal consent, retain local backups, and hold an exclusive lock. Interrupted recovery blocks new transactions until explicitly resolved. Restoring an ordered transaction chain keeps one recovery gate until every step finishes and refuses to overwrite unrelated later edits.

The [native assistant](src/ui.ts) connects selective [global configuration reads](src/global-selection.ts), [profile-file I/O](src/profile-file.ts), and the lifecycle without passing target configuration to its display layer.

The [import lifecycle](src/import.ts) builds on those primitives. `previewImport` returns an immutable, single-use plan; `applyImport` stages the profile and resources without writing global configuration. `previewActivation` checks staged contents and previews conflicts; `activateImport` separately confirms the global references and settings. Plans belong to the `FileStore` instance that created them, keep bytes and snapshots private, and require a new preview after an attempted application. Consent rejection or cancellation before application does not consume a plan.

The import manifest and its transaction ID are written together, not in a later history update. Lifecycle operations cross-check all applied journal IDs and bind the manifest bytes to the latest applicable journal hash: neither replaying an older manifest nor editing receipt paths while retaining IDs is accepted. This is a consistency check, not cryptographic authentication. History inspection permits at most 4,096 backup-directory entries and 32 MiB of journal data per operation; exceeding either limit rejects the operation without changing imported files.

`previewInstallation` lists pinned sources without installing. `installPackages` requires a separate confirmation and a supplied installer factory; the [native adapter](src/pi-installer.ts) uses Pi's public `DefaultPackageManager` with a controlled directory and in-memory settings. Each import gets one exclusive attempt directory. Packages install sequentially; only a complete, revalidated set of contained local paths receives a transactional receipt. The installer does not change native settings or register npm/Git sources globally.

An interrupted or failed attempt retains its files and cannot be retried automatically: use a fresh import. Pi's install API cannot interrupt an in-flight installation; cancellation stops before, between, or after calls. Isolated storage is **not a sandbox**. Installation can access the network and run third-party scripts with your permissions; their files and effects are outside rollback.

Activation uses receipt-backed local paths and preserves package filters. Installation does not activate anything; activation still requires separate confirmation. Global consumers may reread configuration immediately, without waiting for a reload. Agent entrypoints use a generated local package; recursive discovery is checked conservatively against the explicit selection, including Markdown added after staging or preview. Unselected discoverable Markdown blocks activation even if it might not parse as an agent.

`restoreImport` reverses activation, the installation receipt, and staging as one recoverable chain, preserving unrelated later edits. It deliberately leaves installed package files in place. Descriptors remain deferred until installation, and an import already activated without them cannot be installed afterward: use a fresh import.

Recovery covers managed file contents, not original permissions or other metadata, installed packages, or side effects of scripts. It addresses process interruptions and ordinary I/O failures; it does not promise power-loss durability or protection against a hostile local process. Backups can contain local configuration and must stay private. Removing a stale lock requires separate explicit confirmation, never an automatic timeout.

## Participation and rights

This is a collaborative open-source project under the [MIT license](LICENSE). Issues and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through the private channel in [SECURITY.md](SECURITY.md), not public issues. Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

The license covers this repository's code, documentation, and synthetic examples. It does not grant rights to third-party resources or configurations someone may later share with the tool.
