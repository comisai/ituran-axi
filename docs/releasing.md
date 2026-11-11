# Releasing ituran-axi

`.github/workflows/release.yml` publishes to npm when an admin pushes a `v*` tag. Only admins can create, move or delete `v*` tags (the "release tags" ruleset), and the `npm` environment deploys only from those tags. The job publishes with the `NPM_TOKEN` secret of the `npm` environment, and every version carries signed provenance that names this repository: the job's OIDC token signs it. Comis installs an AXI only when its provenance names its source repository.

## Later: trusted publishing

npm can trust the workflow through OIDC ([trusted publishing](https://docs.npmjs.com/trusted-publishers)), so the job holds no npm token. A token that publishes cannot change this setting (npm answers 403), so the package owner does it, signed in with two-step verification:
1. On <https://www.npmjs.com/package/ituran-axi/access>, under **Trusted Publisher**, choose **GitHub Actions** and enter organization or user `comisai`, repository `ituran-axi`, workflow filename `release.yml`, and environment `npm`. Or, with npm 11.19 or later: `npm trust github ituran-axi --file release.yml --repository comisai/ituran-axi --environment npm`.
2. In `release.yml`, remove `NODE_AUTH_TOKEN` from the publish step; npm 11.5.1 or later then exchanges the job's OIDC token for a short-lived publish token.
3. After a release through OIDC succeeds, choose "Require two-factor authentication and disallow tokens" under **Publishing access**, delete the `NPM_TOKEN` secret from the `npm` environment, and revoke that token on npmjs.com.

## Each release

1. In a pull request, set `version` in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), and say what changed in the pull request.
2. Before merging, run the live check against the built CLI (see [CONTRIBUTING](../CONTRIBUTING.md#live-tests)).
3. After the merge, an admin tags the merge commit and pushes the tag:

   ```sh
   git switch main && git pull
   git tag v<x.y.z> && git push origin v<x.y.z>
   ```

4. The workflow checks that the tag matches `package.json`, runs every check, and publishes. A new package version can show as a staged placeholder for about a minute before it appears.
5. Check the result: `npm view ituran-axi@<x.y.z> dist.attestations` names the provenance, and `npm audit signatures` in a project that installs it verifies the signatures.

Comis pins one version with its attestations and a release-age rule. Moving Comis to a new version is a separate Comis pull request.
