# Security

| Line | Support |
| --- | --- |
| Current default branch | Development reports accepted; no released version yet |

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Yivas/pi-setup-share/security/advisories/new). Do not open a public issue with exploit details or sensitive data.

Include the commit, Node.js version, operating system, a minimal synthetic reproduction, expected and observed behavior, impact, and any workaround. Remove credentials, environment values, personal paths, private endpoints, prompts, sessions, and real configuration. A short artificial input that reproduces the problem is preferable to a real exported profile.

## Current boundaries

The implemented validator processes resource data without loading it, installing packages, or writing files. It checks format and lexical paths, not filesystem containment, signatures, secret absence, or whether resource code and prompts are trustworthy. The resource format is still a development draft. No setup importer, backup, or sandbox is available yet.

Never treat a successful validation as permission to execute content. Do not use the current prototype to move a real setup.

The maintainer will assess reports and coordinate a correction and disclosure when applicable. No response deadline, reward, CVE assignment, or support agreement is promised. If a credential was exposed, revoke it through its provider rather than including it in a report.
