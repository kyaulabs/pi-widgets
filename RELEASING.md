# Releasing

Releases follow the repository's protected `develop` → `release/X.Y.Z` → `main` flow.
The release workflow publishes the same npm tarball to GitHub Packages and a GitHub
Release. Publishing that version to the public npm registry remains a deliberate local
maintainer action.

## 1. Prepare a release branch

Start from the current `develop` branch and choose a stable Semantic Version:

```sh
git switch develop
git pull --ff-only origin develop
git switch -c release/X.Y.Z
npm version X.Y.Z --no-git-tag-version --allow-same-version
npm ci
npm run check
npm pack --dry-run
gitleaks git --redact --no-banner
git add package.json package-lock.json
git diff --cached --quiet || git commit -S -m "chore(release): prepare vX.Y.Z"
git push --set-upstream origin release/X.Y.Z
```

The version in `package.json`, the root lockfile version, and the release branch suffix
must match exactly. Release branches and commits must satisfy the repository rulesets.

Open a pull request from `release/X.Y.Z` to `main`, obtain the required review, and merge
it. Only a merged release PR from this repository triggers publication.

## 2. Automated GitHub publication

After the release PR merges, `.github/workflows/release.yml`:

1. validates the merge commit, release branch, and package versions;
2. runs type checking and the coverage suite;
3. builds the publishable npm tarball;
4. generates release notes from Conventional Commits with git-cliff;
5. publishes the tarball to GitHub Packages;
6. creates `vX.Y.Z` and a GitHub Release with the tarball attached; and
7. opens a `main` → `develop` back-merge pull request when needed.

The workflow can be rerun safely after a partial failure. Its manual dispatch is only a
recovery path and requires the same version plus the full release merge SHA on `main`.
It does not replace the reviewed release pull request.

## 3. Publish the identical version to npm

Wait for the GitHub release workflow to pass, then update the local `main` checkout:

```sh
git switch main
git pull --ff-only origin main
git fetch --tags origin
npm ci
npm run check
npm pack --dry-run
```

Confirm that `HEAD`, the release tag, and the package version agree:

```sh
test "$(git rev-parse HEAD)" = "$(git rev-list -n 1 vX.Y.Z)"
test "$(node -p "require('./package.json').version")" = "X.Y.Z"
```

Authenticate to the public npm registry with a maintainer account that can publish the
`@kyaulabs` scope, then publish from the clean checkout:

```sh
npm publish --registry=https://registry.npmjs.org --access=public
```

Do not change the manifest or rebuild generated runtime files between the GitHub and npm
publications. Both registries should receive the version reviewed and merged into `main`.
Finally, review and merge the workflow's back-merge pull request into `develop`.
