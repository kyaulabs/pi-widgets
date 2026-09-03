# Security policy

## Supported versions

Security fixes are released for the latest published minor version.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` | Yes |
| Older versions | No |

This table will change when the project publishes a new minor or major release.

## Report a vulnerability

Email [git@kyaulabs.com](mailto:git@kyaulabs.com). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, installation source, impact, reproduction steps, and any known workaround. Remove API keys, credentials, prompts, and private settings from logs or examples. If encrypted communication is required, request a suitable channel in the first message.

The maintainer will confirm receipt, investigate the report, and coordinate disclosure with the reporter. Fix timing depends on severity, reproducibility, and upstream Pi behavior.

Report vulnerabilities in Pi or another dependency to that dependency's maintainers unless this package creates or exposes the problem.

## Security boundary

Pi extensions execute with the same operating-system permissions as Pi. Review package source before installation.

`gpt-fast-mode-status.ts` reads Pi's settings and keybindings files. When enabled for a supported model, it adds `service_tier: "priority"` to the outgoing provider payload. `tps-status.ts` observes Pi lifecycle, usage, and tool events and writes terminal status text. Neither extension stores credentials or sends telemetry.
