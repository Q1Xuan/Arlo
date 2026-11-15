#!/usr/bin/env bash
set -euo pipefail

# An unprivileged user/mount namespace, not host root. The only mapped UID is
# the invoking user. All mounts disappear with the namespace; no accounts change.
repo=$(cd "$(dirname "$0")/.." && pwd)
node=$(command -v node)
ip=$(command -v ip || test ! -x /sbin/ip || printf '%s' /sbin/ip)
json=${ARLO_OWNERSHIP_JSON:-0}
owned=$(mktemp -d "${HOME}/arlo-ownership-XXXXXX")
printf '%s\n' 'Arlo issue 5 ownership namespace' > "$owned/.owner"
cleanup() {
  if [[ -f "$owned/.owner" && $(<"$owned/.owner") == 'Arlo issue 5 ownership namespace' ]]; then
    rm -rf -- "$owned"
  fi
}
trap cleanup EXIT

# Deadline belongs to unshare itself. Killing an outer shell alone would leave
# its namespace child running; unshare's death kills namespace PID 1 and members.
timeout --foreground --signal=KILL 40s unshare --user --map-root-user --mount --pid --fork --net --kill-child=SIGKILL -- bash -s -- "$repo" "$node" "$owned" "$ip" "$json" <<'NAMESPACE'
set -euo pipefail
repo=$1
node=$2
owned=$3
ip=$4
json=$5
mount --make-rprivate /
"$ip" link set lo up
root="$owned/root"
mkdir -p "$root"/{home,foreign-directory}
chmod 700 "$root" "$root/home"
source "$repo/tests/fixtures/linux-readonly-root.sh"
prepare_readonly_root "$root" "$repo" "$node" "$(command -v flock)" "$(command -v mount)" "$(command -v umount)"
touch "$root/foreign-file"
# Public, host-root-owned fixtures appear with an unmapped UID in this namespace.
# Neither their contents nor any host-private files are read by the tests.
bind_readonly /bin/true "$root/foreign-file"
bind_readonly /usr/share "$root/foreign-directory"
reporter=()
if [[ "$json" == 1 ]]; then reporter=(--test-reporter /repo/acceptance/reporter.mjs); fi
chroot=$(command -v chroot)
env -i HOME=/home PATH=/usr/bin:/bin ARLO_OWNERSHIP_NAMESPACE=1 \
  NODE_OPTIONS=--import=/repo/tests/fixtures/linux-ownership-preload.mjs \
  "$chroot" "$root" /usr/bin/node --test "${reporter[@]}" \
  --test-name-pattern='Linux CLI and SDK|real foreign-owned' \
  /repo/tests/linux-startup.test.ts /repo/tests/linux-ownership.test.ts
if [[ "$json" == 1 ]]; then
  env -i HOME=/home PATH=/usr/bin:/bin "$chroot" "$root" /usr/bin/node --input-type=module -e '
    import fs from "node:fs";
    const files = fs.readdirSync("/home/network");
    const deniedConnections = files.reduce((total, file) => total + JSON.parse(fs.readFileSync(`/home/network/${file}`)).deniedConnections, 0);
    console.log(JSON.stringify({ event: "namespace-network", processCount: files.length, deniedConnections }));
  '
fi
NAMESPACE
