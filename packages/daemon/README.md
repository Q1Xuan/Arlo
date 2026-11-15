# Arlo CLI

Arlo manages native host registration and queries the shared communication Daemon.
The compiled CLI runs JavaScript and does not require a DSH installation for
generic commands.

Run `arlo` in an interactive terminal to select installation / access setup,
diagnostic, status, or uninstall. Cancel with `0`, `q`, an empty line, EOF, or
Ctrl+C. Without a terminal, or with `--json`, an omitted command queries status
without prompting.

Explicit commands continue to run directly:

```text
arlo serve [--state-dir DIR] [--port PORT]
arlo status [--state-dir DIR] [--json]
arlo doctor [--state-dir DIR] [--json]
arlo setup --host pi [--target HOST_PACKAGE_DIR] [--agent-dir DIR] [--apply] [--json]
arlo setup-status --host pi --target HOST_PACKAGE_DIR [--agent-dir DIR] [--json]
arlo uninstall --host pi --target HOST_PACKAGE_DIR [--agent-dir DIR] [--apply] [--json]
```

Pi setup lists verified existing npm/pnpm installations in a terminal. Select the
exact physical installation, or locate its existing package directory or Pi bin
manually. Noninteractive commands require an explicit `--target`; setup never
downloads, upgrades or switches Pi. `--adapter DIR` still supports a preinstalled
compiled adapter and preserves manual registration ownership.

The compiled CLI's release catalog identifies the four exact component versions.
Setup resolves a standard npm/pnpm plan, shows the durable destination, borrowed
physical peers and native user declaration, then asks for confirmation. In scripts,
preview first and repeat with `--apply`; the apply plan goes to stderr and the final
JSON result goes to stdout. Cancel, EOF or Ctrl+C leave the durable installation
and Pi settings untouched.

Components live under the current user's Arlo data directory (XDG data home on
Linux, local application data on Windows), outside the CLI cache. The selected
Pi installation remains unchanged. Its physical peers are linked into an owned
companion consumer using npm external-folder links or the owner's exact pnpm
version and `link:` dependencies. Later CLI invocations recover the same adapter
through the private setup record, including after a cache change. Multiple user
scopes can share a verified component resource.
Confirmed setup also records a verified manual declaration's shared use of an
existing owned resource, while preserving the manual native registration unowned.

`setup-status` reports missing, partial or installed components separately from
the native configuration. Failed consumption leaves an owned partial resource
for a same-target retry. A native registration failure can leave installed
components; an ambiguous declaration or later component edit requires review.
Records contain ownership and installation metadata, never configuration
snapshots. Keep the original settings and private records when resolving a conflict.
If recorded component files disappear, disk status names the missing components
and setup preserves the remaining consumer for review instead of overwriting it.

DSH registration additionally requires an existing prepared host and an explicit
`--profile NAME`, with `--dsh-home DIR` when needed. Setup previews changes before
`--apply`. Uninstall currently removes owned native registration; complete owned
component cleanup is a separate lifecycle step.

`status` and `doctor` observe the shared Daemon. `setup-status` observes persistent
host configuration. Configuration does not prove that a host has loaded an adapter
or that communication has succeeded. Start or reload the selected host normally
and use its native diagnostic tools to obtain that evidence.

Public package availability and publication permissions are still unverified.
An install command will be documented after the coordinated release is published
and the public entry has been verified.
