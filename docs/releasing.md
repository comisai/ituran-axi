# Releasing ituran-axi

`.github/workflows/release.yml` publishes to npm when an admin pushes a `v*` tag. Only admins can create, move or delete `v*` tags (the "release tags" ruleset), and the `npm` environment deploys only from those tags. npm trusts the workflow through OIDC ([trusted publishing](https://docs.npmjs.com/trusted-publishers)), so the job holds no npm token, and every version carries signed provenance that names this repository. Comis installs an AXI only when its provenance names its source repository.

## One-time setup: the trusted publisher

Until this is done, the publish step fails and nothing is published. A token that publishes cannot change this setting (npm answers 403), so the package owner does it, signed in with two-step verification.

On npmjs.com:
1. Open <https://www.npmjs.com/package/ituran-axi/access>.
2. Under **Trusted Publisher**, choose **GitHub Actions**.
3. Enter organization or user `comisai`, repository `ituran-axi`, workflow filename `release.yml`, and environment `npm`.
4. Save. Under **Publishing access**, choose "Require two-factor authentication and disallow tokens", so only the workflow can publish.

Or, from a terminal with npm 11.19 or later, signed in as the owner:

```sh
npm trust github ituran-axi --file release.yml --repository comisai/ituran-axi --environment npm
```

After the first release through OIDC succeeds:
1. Delete the `NPM_TOKEN` secret from the `npm` environment (repository **Settings → Environments → npm**).
2. Revoke that token on npmjs.com (**Access Tokens**).

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
