## Summary

Describe the problem and the chosen solution.

## User-visible effects

List changes to commands, settings, supported models, timing, terminal output, or compatibility. Write `None` when the change has no user-visible effect.

## Verification

- [ ] `npm run check`
- [ ] `npm pack --dry-run`
- [ ] Gitleaks scan
- [ ] Manual Pi check, when runtime behavior changed
- [ ] Standard Pi and Zentui checks, when their shared status events changed

Add relevant test output or manual steps below.

## Checklist

- [ ] The change has one reviewable purpose.
- [ ] Tests cover new behavior and failure paths.
- [ ] Documentation matches commands, settings, and visible output.
- [ ] No credentials, private prompts, generated coverage, or local settings are included.
- [ ] Commits follow Conventional Commits.

## Related issues

Use `Fixes #123` for an issue this pull request closes, or `Refs #123` for related work.
