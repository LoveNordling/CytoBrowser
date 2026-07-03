#!/usr/bin/env bash
set -euo pipefail

src_dir=${1:-"../beetle/data/Spruce Bark Beetle Data-20260702T084834Z-3-001/Spruce Bark Beetle Data"}
out_dir=${2:-"data"}

if ! command -v vips >/dev/null 2>&1; then
    echo "ERROR: libvips is required. Install vips, then rerun this script." >&2
    exit 1
fi

if [[ ! -d "$src_dir" ]]; then
    echo "ERROR: source directory not found: $src_dir" >&2
    exit 1
fi

mkdir -p "$out_dir"

count=0
converted=0
skipped=0

while IFS= read -r -d '' jpg; do
    count=$((count + 1))
    base=$(basename "$jpg")
    name=${base%.*}
    target="$out_dir/${name}_z0"

    if [[ -f "${target}.dzi" && -d "${target}_files" ]]; then
        echo "skip: ${name}_z0"
        skipped=$((skipped + 1))
        continue
    fi

    echo "convert: $base -> ${target}.dzi"
    vips dzsave "$jpg" "$target" --tile-size 256 --overlap 0 --suffix '.jpg[Q=90]'
    converted=$((converted + 1))
done < <(find "$src_dir" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) -print0 | sort -z)

echo
echo "Done. Found $count JPEG files; converted $converted; skipped $skipped."
echo "CytoBrowser can load these from: $out_dir"
