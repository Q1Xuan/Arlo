// Only classify failures from the initial capability probe. Once a namespace
// has been created successfully, fixture failures must remain test failures.
export function namespaceUnavailable(probe) {
  return probe.error?.code === 'ENOENT' || (probe.status !== 0 &&
    /unshare: (?:unshare failed|mount[^\n]*failed|write failed \/proc\/self\/(?:uid_map|gid_map|setgroups)): (?:Operation not permitted|Permission denied|Invalid argument)(?:\r?\n|$)/.test(probe.stderr ?? ''));
}
