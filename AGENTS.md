# AGENTS.md

- Development must use TDD (Red, Green, Refactor)
- Code coverage must remain >= 95%
- Repository rulesets are in place and must be respected
- Start changes from current `origin/develop` on `type/$USER-$(openssl rand -hex 3)-name-of-branch`
- Release branches use `release/X.Y.Z` from current `develop`, as required by `RELEASING.md`
- All commits must use conventional commits syntax, also no more than 100 chars per line
- Use detailed commit messages and commit atomically
- Make sure all workflows pass remotely before declaring a branch finished

## Automatic PR and release procedure

- Execute this procedure without additional prompts when asked to ship changes or a release.
- All Git pushes must use normal local `git` authentication as `kyau`, never a bot token.
- Sign local commits with `kyau`'s locally available GPG key (`git commit -S`).
- Create PRs and perform merges with `gh` authenticated as `kyaulabs-bot`.
- After creating each PR, review its diff, run `npm run check`, `npm pack --dry-run`,
  and the secret scan; wait for all remote PR checks and confirm every check passes.
- Only then approve the tested head as `kyau`, using a command-scoped token:
  `GH_TOKEN="$(gh auth token --user kyau)" gh pr review <number> --approve`.
- Merge as `kyaulabs-bot` only after verifying the approval and unchanged tested head.
  Use `gh pr merge --merge --match-head-commit <sha>`; never bypass protections.
- If the head changes, repeat validation and approval. Stop on failed checks or missing auth.
- Follow `RELEASING.md` for publication; monitor release and post-merge CI to completion.
- Apply the same checks, identity split, approval, and merge process to release and back-merge PRs.
- If the release workflow opens a back-merge PR as `github-actions[bot]`, replace it with a
  `kyaulabs-bot` PR before proceeding. Do not store personal credentials in workflows.
- Keep `kyaulabs-bot` as the active `gh` account; use scoped credentials for `kyau` reviews.

