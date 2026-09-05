# Security

| Line | Support |
| --- | --- |
| Current default branch | Development reports accepted; no released version yet |

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Yivas/pi-setup-share/security/advisories/new). Do not open a public issue with exploit details or sensitive data.

Include the commit, Node.js version, operating system, a minimal synthetic reproduction, expected and observed behavior, impact, and any workaround. Remove credentials, environment values, personal paths, private endpoints, prompts, sessions, and real configuration. A short artificial input that reproduces the problem is preferable to a real exported profile.

## Current boundaries

The core exports selected resources, stages imports, backs up and restores managed files, and separately installs and activates packages. The command interface is not available yet. Validation itself performs no filesystem or network actions. It checks format and lexical paths, not signatures, secret absence, or whether resource code and prompts are trustworthy. The format remains a development draft.

Installation is separate code-execution consent. A per-import directory is not a sandbox: package managers and third-party scripts retain your permissions. Installed files and external script effects are outside rollback. Activation requires another confirmation and may affect consumers before a reload.

Filesystem checks and journals address ordinary changes and interrupted operations, not hostile-process races or power-loss durability. Backups can contain local configuration and must remain private. Journal hashes detect inconsistent managed contents; they do not authenticate an untrusted profile or defend against someone rewriting the whole local store.

Never treat a successful validation as permission to execute content. Do not use the current prototype to move a real setup.

The maintainer will assess reports and coordinate a correction and disclosure when applicable. No response deadline, reward, CVE assignment, or support agreement is promised. If a credential was exposed, revoke it through its provider rather than including it in a report.
