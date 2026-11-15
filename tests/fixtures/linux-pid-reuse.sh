#!/usr/bin/env bash
set -euo pipefail

# Already inside the caller-owned user/mount/PID namespace. All mounts vanish
# when namespace PID 1 exits. The chroot keeps unmapped host ancestors outside
# the production runtime permission checks and exposes no real user profile.
root=$1
node=$2
repo=$3
owner=$4
shift 4
mount --make-rprivate /
source "$repo/tests/fixtures/linux-readonly-root.sh"
prepare_readonly_root "$root" "$repo" "$node" "$(command -v flock)" "$(command -v sleep)"
chroot=$(command -v chroot)
exec env -i HOME=/home PATH=/usr/bin:/bin LANG=C.UTF-8 \
  XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data XDG_CACHE_HOME=/cache \
  XDG_STATE_HOME=/state XDG_RUNTIME_DIR=/runtime TMPDIR=/temp \
  ARLO_ACCEPTANCE_ROOT=/isolation ARLO_ACCEPTANCE_OWNER="$owner" \
  NODE_OPTIONS=--import=file:///repo/acceptance/preload.mjs \
  "$chroot" "$root" /usr/bin/node "$@"
