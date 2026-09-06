# Changelog

## Unreleased

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
