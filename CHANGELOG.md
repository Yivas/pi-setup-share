# Changelog

## 0.4.0 — 2026-09-24

### Added

- Decide each conflict by item: keep, replace or skip, separately for pinned packages, local resources and MCP servers. Duplicate resource paths require an explicit source choice, and a colliding resource path can be omitted entirely.
- See progress while long operations run: a determined bar only while the total is real, a named phase otherwise, a bounded list of recent results and cancellation shown as a request. Staging, package installation and activation report one element at a time.

### Security and compatibility

- Profile reading and writing are unchanged: new exports remain one-entry ZIP archives with a v2 `profile.json`, and v1 ZIP and legacy plain JSON still import. Receivers on 0.2.0 cannot read v2 profiles; update both computers before sharing a new export.
- Progress reports counts, phases and outcomes only. It never shows paths, values or file contents, and each increment confirms one durable write rather than the completion of the operation: success is announced only after the whole transaction commits.
- The whole-directory copy machinery (literal transfer) is not part of this release: it has no entry point in the assistant and cannot be enabled. Pi 0.85.0 does not hand an extension a verifiable identity for the root Pi was using, and Windows ACLs cannot be checked from Node, so the mode stays disconnected and documented instead of offered.

## Unreleased

### Fixed

- Long review lists no longer grow upwards over Pi's own frame. The body of a review is sized so the whole component always leaves rows free for the header, input, status and footer; with a long profile summary the beginning of the review used to scroll out of sight in a real terminal. Selection lists reserve the same margin.

## 0.3.0 — 2026-09-23

### Added

- Inventory known global extensions, skills, prompts, themes, and agents before selective export; keep manual file selection available.
- Include a bounded sender inventory report and recipient actions in v2 profiles inside the existing one-entry ZIP.

### Security and compatibility

- Reject known credential and operational file paths during export and import, including sensitive manual roots; inventory limits are reported as partial coverage.
- Continue reading v1 ZIP and plain JSON profiles. Receivers running 0.2.0 cannot open v2 profiles; update both computers to 0.3.0 before sharing a new export.

## 0.2.0 — 2026-09-06

### Added

- Export profiles as a standard ZIP containing one `profile.json`, while retaining legacy JSON import.
- Select every portable MCP server at once and show safe local reasons for servers that cannot be shared.

### Security

- Bound archive size and decompressed profile bytes; reject extra entries, directories, encryption, comments, inconsistent sizes, invalid CRC, and unsupported ZIP structure without extracting files.

### Compatibility

- Upgrade the receiving installation to 0.2.0 before sharing a new ZIP. Existing plain JSON profiles remain importable.

## 0.1.1 — 2026-09-06

### Changed

- Published the existing native extension as the public `pi-setup-share` npm package.
- Added Pi package discovery metadata and documented global and temporary npm installation.

There are no functional or profile-format changes from 0.1.0.

## 0.1.0 — 2026-09-06

First GitHub release. Requires Pi 0.85.0 and Node.js 22.19.0 or newer.

### Added

- Native `/setup-share` assistant for selective export, inspection, import, resume, restore, and recovery.
- Selection of portable preferences, keybindings, local resources and entrypoints, pinned npm/Git packages, and documented MCP/subagent settings.
- Separate staging, package-installation, and activation confirmations, with Later and preservation as defaults.
- Bounded profile files, managed backups, change detection, and recovery that preserves later edits.

### Compatibility and limits

- Global configuration only. The profile format is a development draft; no cross-version migration contract is promised.
- Inspection does not execute resources. Package installation may execute third-party code; isolated storage is not a sandbox, and package files/script effects cannot be rolled back.
- TUI-only, with automated native-host checks at 80×24 and 120×40. Tests do not replace a full physical-terminal walkthrough or a real network installation.
- Distributed as source through GitHub, not npm. MIT covers this project's code and documentation, not imported profiles or third-party resources.
