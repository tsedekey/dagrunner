#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${HOME}/.local/share/dagrunner/build-queue"
OUT_DIR="${HOME}/Downloads"

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <name>" >&2
  exit 1
fi

name="${1%/}"
folder="${BASE_DIR}/${name}"

if [[ ! -d "$folder" ]]; then
  echo "Error: '${folder}' is not a directory" >&2
  exit 1
fi

output="${OUT_DIR}/${name}.zip"
zip -r "$output" "$folder"
echo "Created: $output"
