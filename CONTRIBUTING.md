# Contributing

Bug reports, focused feature proposals, documentation fixes, and tested code changes are welcome.

## Before opening an issue

Search the existing issues first. For a bug, include:

- Pi, Node.js, operating system, and terminal versions;
- the active provider and model when the problem involves Fast mode;
- whether the standard Pi interface or Zentui is active;
- the smallest settings and event sequence that reproduces the problem; and
- the expected and observed output.

Do not include API keys, credentials, private prompts, or complete settings files.

## Development setup

Fork the repository and create a branch from `develop`:

```sh
git clone https://github.com/YOUR-NAME/pi-widgets.git
cd pi-widgets
npm install
npm run hooks:install
git switch -c feat/short-description develop
```

The tracked hooks require [Gitleaks](https://github.com/gitleaks/gitleaks). Install it through your operating system's package manager before committing.

## Make a change

Keep each change limited to one purpose. Preserve these runtime contracts:

- Extensions must load through Pi's TypeScript package loader without generated files.
- `@earendil-works/pi-coding-agent` must remain an unbundled peer dependency.
- Session shutdown must clear timers and UI state.
- TPS measurements must not count Bash or PowerShell execution time.
- Unsupported models must not receive `service_tier: "priority"`.

Tests should assert behavior at the Pi extension boundary. Use temporary files for configuration and deterministic clocks for timing. Do not expose private production functions only to increase coverage.

Update the README when commands, settings, supported models, installation, or visible output changes.

## Verify the change

Run:

```sh
npm run check
npm pack --dry-run
gitleaks detect --source . --verbose --no-color --max-target-megabytes 5
```

`npm run check` runs TypeScript and coverage tests. Coverage must remain at or above 95 percent for statements, branches, functions, and lines. Inspect the tarball listing from `npm pack --dry-run`; test files, coverage output, and local configuration must not be published.

A TPS rendering change also needs a manual Pi check. Exercise the standard interface and Zentui when the change affects their shared event contract.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope]: <subject>

Explain the reason for the change and any behavior that is not clear from the diff.
```

Common types are `feat`, `fix`, `docs`, `test`, `build`, `ci`, and `chore`. Keep the header and each body line within 100 characters. The commit hook checks every message.

## Pull requests

Open pull requests against `develop`. Include:

- the problem and the chosen solution;
- user-visible or compatibility effects;
- automated and manual verification; and
- linked issues, when applicable.

A maintainer may ask for a smaller change or an additional test when the current scope makes behavior difficult to review.

## Releases

Maintainers should follow [RELEASING.md](RELEASING.md) for the protected release-branch flow,
GitHub publication, and the final manual npm publication.

By submitting a contribution, you agree that it is licensed under the repository's [GNU Affero General Public License v3.0](LICENSE).
