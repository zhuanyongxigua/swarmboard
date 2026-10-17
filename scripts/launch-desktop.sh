#!/bin/sh
# Finder-launched desktop apps may omit Node from PATH. Resolve a supported
# runtime without sourcing shell profiles, changing global PATH, or writing data.
set -eu
server_directory=$(CDPATH= cd -- "${0%/*}" && pwd)

supported_node() {
  [ -x "$1" ] && "$1" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; if (Number(process.versions.node.split(".")[0]) < 24 || !DatabaseSync) process.exit(1);' >/dev/null 2>&1
}
launch() {
  exec "$1" "$server_directory/swarmboard.mjs"
}
if [ -n "${SWARMBOARD_NODE:-}" ]; then
  if supported_node "$SWARMBOARD_NODE"; then launch "$SWARMBOARD_NODE"; fi
  printf '%s\n' 'Swarmboard: SWARMBOARD_NODE must point to a working Node.js 24+ executable with node:sqlite.' >&2
  exit 127
fi
path_node=$(command -v node 2>/dev/null || true)
if [ -n "$path_node" ] && supported_node "$path_node"; then launch "$path_node"; fi
for candidate in \
  "${NVM_BIN:-/nonexistent}/node" \
  "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/*/bin/node \
  "${VOLTA_HOME:-${HOME:-}/.volta}/bin/node" \
  /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if supported_node "$candidate"; then launch "$candidate"; fi
done
printf '%s\n' 'Swarmboard: Node.js 24+ with node:sqlite was not found. Install Node.js or set SWARMBOARD_NODE to its absolute executable path.' >&2
exit 127
