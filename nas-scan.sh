#!/usr/bin/env bash
# Reading Library — NAS eBook scanner
# Lists eBook files under a folder and writes nas-books.txt (one book per line),
# which you then upload in the app's Scan → NAS eBooks importer.
#
# Usage:
#   ./nas-scan.sh "/Volumes/Berryhill-NAS/Books"
#   ./nas-scan.sh "/Volumes/Berryhill-NAS/Books" > ~/Desktop/nas-books.txt
#
# Tips for best title/author matching, name files like:  "Title - Author.epub"

DIR="${1:-.}"
OUT="${2:-nas-books.txt}"

if [ ! -d "$DIR" ]; then
  echo "Folder not found: $DIR" >&2
  echo "Is the NAS mounted? Check /Volumes." >&2
  exit 1
fi

# Find common ebook formats, strip the path, keep just the filename.
find "$DIR" -type f \( \
  -iname '*.epub' -o -iname '*.mobi' -o -iname '*.azw' -o -iname '*.azw3' \
  -o -iname '*.pdf' -o -iname '*.fb2' -o -iname '*.cbz' -o -iname '*.txt' \
  \) -print0 \
  | xargs -0 -n1 basename \
  | sort -u > "$OUT"

echo "Wrote $(wc -l < "$OUT" | tr -d ' ') titles to $OUT" >&2
