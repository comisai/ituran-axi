# Security Policy

ituran-axi handles fleet credentials and personal data, such as vehicle positions and driver names, so we take security reports seriously.

## Supported versions

Security fixes go to `main` and to the next `0.x` release on npm. Only the latest release is supported.

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub:
1. Go to the [Security tab](https://github.com/comisai/ituran-axi/security/advisories/new).
2. Choose **Report a vulnerability**.

Include:
- what the problem is, and what an attacker could do with it;
- the commit or version affected;
- the steps to reproduce it, ideally against the fake Ituran in `test/fake/`.

Never include real passwords, tokens, plates, names or positions. The maintainers will acknowledge your report, keep you informed while they work on a fix, and agree on the disclosure with you.

## Scope

**In scope:**
- A password or token appearing in output, errors, logs, or files other than the token cache.
- The token cache readable by other users, or reused for a different account or API root.
- Any request that is not a read: a write, a device command, or a POST to a route outside `READ_POSTS`.
- A request sent to a host other than the configured API root.
- A bypass of the text-safety layer: invisible or bidirectional characters, or credential-like values, passing through unescaped.
- Phone numbers or e-mail addresses shown without `--full` or `--fields`.

**Out of scope:**
- Vulnerabilities in the Ituran API or its services; report those to Ituran.
- Vulnerabilities in Comis; report those to the Comis maintainers.
