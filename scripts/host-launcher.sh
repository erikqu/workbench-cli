#!/bin/sh
set -eu
workbench_script=$0
while [ -L "$workbench_script" ]; do
  workbench_parent=$(CDPATH= cd -- "$(dirname -- "$workbench_script")" && pwd)
  workbench_link=$(readlink "$workbench_script")
  case "$workbench_link" in /*) workbench_script=$workbench_link ;; *) workbench_script=$workbench_parent/$workbench_link ;; esac
done
workbench_base=$(CDPATH= cd -- "$(dirname -- "$workbench_script")/.." && pwd)
exec "$workbench_base/bin/node" "$workbench_base/lib/host.mjs" "$@"
