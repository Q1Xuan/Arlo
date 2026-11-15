#!/usr/bin/env bash

# Shared preparation only. Callers own their namespace, private directories,
# lifecycle deadline and scenario-specific mounts.
bind_readonly() {
  mount --bind "$1" "$2"
  mount -o remount,bind,ro "$2"
}

prepare_readonly_root() {
  local root=$1 repo=$2 directory binary target
  shift 2
  mkdir -p "$root"/{repo,usr/bin,usr/lib,lib,lib64,dev,proc}
  bind_readonly "$repo" "$root/repo"
  for directory in /lib /lib64 /usr/lib/*-linux-gnu; do
    if [[ -d "$directory" ]]; then
      mkdir -p "$root$directory"
      bind_readonly "$directory" "$root$directory"
    fi
  done
  for binary in "$@"; do
    target="$root/usr/bin/$(basename "$binary")"
    touch "$target"
    bind_readonly "$binary" "$target"
  done
  touch "$root/dev/null"
  mount --bind /dev/null "$root/dev/null"
  mount -t proc proc "$root/proc"
}
