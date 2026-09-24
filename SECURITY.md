# Security

| Line | Support |
| --- | --- |
| 0.3.x | Security reports accepted; fixes target the latest patch |
| 0.2.x | Reports accepted; upgrade to the current line when possible |
| 0.1.x | Reports accepted; upgrade to the current line when possible |
| Current default branch | Development reports accepted |

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Yivas/pi-setup-share/security/advisories/new). Do not open a public issue with exploit details or sensitive data.

Include the commit, Node.js version, operating system, a minimal synthetic reproduction, expected and observed behavior, impact, and any workaround. Remove credentials, environment values, personal paths, private endpoints, prompts, sessions, and real configuration. A short artificial input that reproduces the problem is preferable to a real exported profile.

## Current boundaries

The core exports selected resources, stages imports, backs up and restores managed files, and separately installs and activates packages. The native `/setup-share` assistant connects these operations with explicit selections and separate confirmations. Version 0.4.0 exports ZIP archives containing one v2 `profile.json` and a sender-supplied inventory report; v1 ZIP and legacy plain JSON remain readable. Version 0.2.0 cannot read v2 reports. Archive parsing is bounded before and during decompression and never extracts members to disk. Validation itself performs no filesystem or network actions. It checks format and lexical paths, not signatures, secret absence, or whether resource code and prompts are trustworthy. The format remains a development draft.

Installation is separate code-execution consent. A per-import directory is not a sandbox: package managers and third-party scripts retain your permissions. Installed files and external script effects are outside rollback. Activation requires another confirmation and may affect consumers before a reload.

Filesystem checks and journals address ordinary changes and interrupted operations, not hostile-process races or power-loss durability. Backups can contain local configuration and must remain private. Journal hashes detect inconsistent managed contents; they do not authenticate an untrusted profile or defend against someone rewriting the whole local store.

The assistant keeps profile data out of model messages, session entries, and its diagnostics. Displayed data can still be recorded by the terminal or observed by other extensions in the same Pi process. Selected resource contents are transferred and can contain secrets that filename rules cannot detect. Known sensitive names and root locations are excluded on export, and known sensitive relative paths are rejected on import; neither check is content scanning. The report gives bounded category counts, not evidence that the sender scanned every file or that the imported code is safe. Incomplete profile exports and package attempts are retained rather than automatically deleted or reused.

A ZIP is rejected when it has extra or renamed entries, directories, encryption, comments, inconsistent sizes, an invalid CRC, unsupported structure, more than 17 MiB compressed, or more than 16 MiB of profile JSON. These checks reduce archive traversal and decompression-bomb risk; they do not authenticate the sender or make profile contents trustworthy.

MCP export includes only portable servers. Servers with local transports, paths, sockets, private endpoints, secret-like arguments, or invalid fields remain outside the archive; the UI reports their validated names and a safe local reason without copying rejected values.

Never treat a successful validation as permission to execute content. Use synthetic profiles and a disposable Pi user directory for your first evaluation.

The maintainer will assess reports and coordinate a correction and disclosure when applicable. No response deadline, reward, CVE assignment, or support agreement is promised. If a credential was exposed, revoke it through its provider rather than including it in a report.
