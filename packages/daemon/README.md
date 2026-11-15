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
arlo setup --host pi --target HOST_PACKAGE_DIR --adapter ADAPTER_PACKAGE_DIR [--agent-dir DIR] [--apply] [--json]
arlo setup-status --host pi --target HOST_PACKAGE_DIR --adapter ADAPTER_PACKAGE_DIR [--agent-dir DIR] [--json]
arlo uninstall --host pi --target HOST_PACKAGE_DIR --adapter ADAPTER_PACKAGE_DIR [--agent-dir DIR] [--apply] [--json]
```

DSH registration additionally requires an existing prepared host and an explicit
`--profile NAME`, with `--dsh-home DIR` when needed. Setup previews changes before
`--apply`. The registration flow uses installed compiled components; uninstall
removes owned registration and leaves component management to the package manager.

`status` and `doctor` observe the shared Daemon. `setup-status` observes persistent
host configuration. Configuration does not prove that a host has loaded an adapter
or that communication has succeeded. Start or reload the selected host normally
and use its native diagnostic tools to obtain that evidence.

Public package availability and publication permissions are still unverified.
An install command will be documented after the coordinated release is published
and the public entry has been verified.
