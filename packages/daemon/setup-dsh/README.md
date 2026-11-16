# DSH installation and profile setup

The compiled Arlo CLI can prepare an existing DSH 0.2.1-rc.5 installation and
register its adapter in one existing profile. Use the compiled CLI supplied with
the coordinated release. Public package names and the public install command are
documented after publication and independent verification.

## Select an installation and profile

Run `arlo` in a terminal and choose **Installation / access setup**, then `dsh`.
The CLI lists verified existing package installations and their physical paths.
Choose the installation you normally start, then one existing profile. If no
installation is found, enter its existing DSH package directory or native launcher.
Use `--dsh-home DIR` to select a DSH home other than the default.

Automatic preparation currently covers locked local npm owners and single-importer
pnpm owners using the standard isolated layout. An npm global prefix, workspace,
redirected owner or conflicting lock stops with guidance to locate a verifiable
installation. Setup preserves that installation and its original startup route.

An ordinary rc.5 dependency graph can differ from the historical complete
composition. Select it explicitly with `--experimental` when the CLI reports
`DSH_EXPERIMENTAL_REQUIRED`. This records the experimental composition choice;
the exact program, browser, dependency and physical peer checks still apply.

For a direct preview, supply the exact existing package directory and profile:

```sh
arlo setup --host dsh --target DSH_PACKAGE_DIR --dsh-home DSH_HOME --profile PROFILE --experimental --json
```

In a terminal, `arlo setup --host dsh --dsh-home DSH_HOME --experimental` also
offers installation and profile selection. A noninteractive command requires
both `--target` and `--profile`. Setup never creates a profile or chooses among
multiple installations without your selection.

## Review and apply

The preview identifies the native package manager, stable component destination,
selected profile and version-specific changes. For rc.5, those changes comprise
trusted new-session creation, browser submit preparation, native JSONL backend
ownership, the reviewed type repair and environment presentation repair. These
repairs have separate purposes; configuration alone is not communication evidence.
Only the missing reviewed browser primitives and slots are added.

The CLI first checks a standard package plan and acquires the exact compiled
components for validation outside the selected targets. Confirm the concrete
preview with `y`, or repeat the preview command with `--apply` in a script:

```sh
arlo setup --host dsh --target DSH_PACKAGE_DIR --dsh-home DSH_HOME --profile PROFILE --experimental --apply --json
```

The apply preview goes to stderr; the final JSON report goes to stdout. Cancellation,
EOF, Ctrl+C or failed preflight preserves the host and selected profile.

Preparation uses the installation's own npm or exact declared pnpm tool. Existing
locked package versions, unrelated dependencies and the native DSH bin are retained.
The durable companion borrows the selected installation's actual physical modules.
Native profile registration adds one adapter dependency and its shipped bundle,
while retaining model configuration, history, other plugins and custom settings.

## Reload and inspect

After `configured-pending-start-or-reload`, start or reload the same profile using
your original DSH command. Inspect the actual Host's `arlo-host-loaded` report for
its Node runtime, adapter identity and required contracts. Then verify contacts
and message exchange in Web.

```sh
arlo setup-status --host dsh --target DSH_PACKAGE_DIR --dsh-home DSH_HOME --profile PROFILE --json
```

Disk status distinguishes preparation, component installation and native
registration. Runtime and communication remain `unobserved` in this report;
`arlo status` and `arlo doctor` separately inspect the shared Daemon. Repeating
setup on the same verified selection reuses the durable resources and one bundle.

## Recover a failed setup

Keep the original settings and private records. Native registration failure reports
the completed transaction phase and original process exit and signal. Disk status
reports `recovery-required` for a prepared registration. Resolve the native
package-manager problem and retry the same target, DSH home and profile. A retry
retains later unrelated settings and clears the failure only after successful
registration.

If the native package tool failed during preparation, status can report the
unfinished owner checkpoint even when pnpm has removed the original package link.
Restore that owner's access and complete its existing frozen install with scripts
disabled through the reported npm/pnpm version, then retry the same Arlo selection.
The CLI verifies the complete actual installation again before registration.
Registration, Host runtime and communication remain unobserved while the native
installation is incomplete.

Owned preparation and component records live under the user's Arlo data directory;
the profile registration record is `PROFILE_DIR/arlo-setup/dsh.json`. These records
contain identities, hashes and precise changes, rather than old configuration
snapshots. If a program, component, declaration or ownership record was edited or
is ambiguous, preserve it and follow the reported recovery guidance. Do not replace
an entire package tree or profile with a prior snapshot.

`--adapter DIR` retains the existing path for registering a verified preinstalled
compiled adapter in a prepared composition. Complete removal of shared components
and owned preparation changes is handled by the DSH cleanup lifecycle.

## Build private companion archives

Maintainers can pack the compiled components for ordinary-host setup from a
verified core build:

```sh
pnpm run build --out .artifacts/core
pnpm run build:web --host-version 0.2.1-rc.5 --companion --core .artifacts/core --out .artifacts/dsh-rc5-companion
```

This mode produces archives and source receipts. The CLI validates and binds their
exact native peers to the selected existing installation during setup. Installation,
original-launcher Host/Web acceptance and public availability require their own
evidence. The default Web build continues to prepare the historical complete
composition with its reviewed dependency closure.
