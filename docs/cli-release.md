# Compiled CLI release candidates

The proposed CLI identity is `@arlo/daemon`, exposing the existing `arlo` bin.
Its only Arlo runtime dependency is the version-matched `@arlo/sdk`.
`@arlo/adapter-sdk` is a separate core component for host adapters. Pi and DSH
components keep their `@arlo/adapter-pi` and `@arlo/adapter-dsh` identities and
are distributed with the matching core versions by their delivery flows.
The generic CLI distribution contains no host package or host peer dependency.

These names are candidates. Anonymous npm registry checks on 2026-11-15 returned
404 for all five Arlo packages. That result establishes neither ownership of the
`@arlo` scope nor permission to publish. The final release must verify scope and
package permissions, coordinate every required component, and check public
metadata and commands after publication. A conflicting or inaccessible identity
must be resolved before publishing or advertising a public installation command.

The existing generic delivery driver can emit either private validation artifacts
or public release candidates. Source workspace manifests remain private. Candidate
mode changes only emitted package manifests to `private: false` and
`publishConfig.access: public`; it never publishes.

Run the following only when full build and package validation are permitted,
using the pinned Node and pnpm versions:

```sh
node scripts/generic-delivery.mjs build --release-candidate --out .artifacts/cli-candidate
node scripts/generic-delivery.mjs verify --out .artifacts/cli-candidate --npx /absolute/path/to/npm/bin/npx-cli.js
```

Compilation rewrites TypeScript entries to JavaScript, emits declarations, replaces
workspace dependency ranges with coordinated exact versions, and includes package
licenses, DSH preparation resources, and the Windows mutex helper. Package file
allowlists exclude tests, skills, local ADRs, glossary additions, and research notes.
Publish only the individual verified package tarballs. The surrounding private
bundle also contains validation fixtures and reports and is not a release package.

Verification consumes the tarballs outside the checkout with a frozen dependency
graph. It audits physical dependency locations and absence of host dependencies,
then drives the compiled `arlo` bin with standard offline `npx`, the terminal menu,
direct CLI commands, and a real isolated Daemon. The runtime guard prevents external
model traffic; no user host installation or configuration is used. Linux terminal
tests require Python 3. Windows terminal and native host evidence remains a separate
acceptance step.

Local tarball and consumer validation does not prove registry availability. The
candidate manifest records publication permission and public availability as
unverified. The final release must supply actual public consumer evidence before
READMEs advertise a working public `npx` command.
