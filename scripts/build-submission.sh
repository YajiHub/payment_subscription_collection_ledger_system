#!/usr/bin/env bash
#
# Assembles the submission folder described in
# specs/phase10-deployment-documentation.md §3.
#
#   pnpm submission
#   BCIS_SUBMISSION_DIR=/tmp/submission pnpm submission
#
# The PDFs (documentation.pdf, manual.pdf, test-report.pdf) are produced only when
# `pandoc` is on PATH. Without it the Markdown sources are copied instead and a
# NOTE.txt explains the gap — the folder is never presented as complete when it is
# not.

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMISSION_DIR="${BCIS_SUBMISSION_DIR:-$REPOSITORY_ROOT/submission/BCIS-Subscription-Billing-System}"

mkdir -p "$SUBMISSION_DIR"/{samples,source,installer}

# Quick-start guide: the repository README.
cp "$REPOSITORY_ROOT/README.md" "$SUBMISSION_DIR/guide.md"

# Full source, as a git archive of the committed tree (no build output, no .env).
git -C "$REPOSITORY_ROOT" archive --format=tar.gz \
  -o "$SUBMISSION_DIR/source/bcis-source.tar.gz" HEAD

# convert_markdown <source.md> <destination.pdf>
# Copies the Markdown next to the PDF target when pandoc cannot produce the PDF.
convert_markdown() {
  local source_file="$1"
  local destination_pdf="$2"

  if command -v pandoc >/dev/null 2>&1; then
    pandoc "$source_file" -o "$destination_pdf"
    echo "Created $(basename "$destination_pdf")"
  else
    cp "$source_file" "${destination_pdf%.pdf}.md"
    echo "pandoc not found — copied $(basename "${destination_pdf%.pdf}").md instead" >&2
  fi
}

convert_markdown "$REPOSITORY_ROOT/docs/technical/README.md" \
  "$SUBMISSION_DIR/documentation.pdf"
convert_markdown "$REPOSITORY_ROOT/docs/user-manual/README.md" "$SUBMISSION_DIR/manual.pdf"

# Test report: the real output of the test suite.
if (cd "$REPOSITORY_ROOT" && pnpm test > "$SUBMISSION_DIR/test-report.txt" 2>&1); then
  echo "Test suite passed."
else
  echo "Test suite FAILED — see test-report.txt" >&2
fi

if command -v pandoc >/dev/null 2>&1; then
  pandoc "$SUBMISSION_DIR/test-report.txt" -o "$SUBMISSION_DIR/test-report.pdf"
else
  echo "pandoc not found — kept test-report.txt instead of test-report.pdf" >&2
fi

# Sample documents, when they have been generated into docs/samples/.
if [ -d "$REPOSITORY_ROOT/docs/samples" ]; then
  cp -R "$REPOSITORY_ROOT/docs/samples/." "$SUBMISSION_DIR/samples/"
else
  echo "No docs/samples/ directory — samples/ is left empty." >&2
fi

# The Windows installer, when one has been built.
shopt -s nullglob
INSTALLERS=("$REPOSITORY_ROOT"/apps/client/installer/*.exe)
shopt -u nullglob

if [ "${#INSTALLERS[@]}" -gt 0 ]; then
  cp "${INSTALLERS[@]}" "$SUBMISSION_DIR/installer/"
  echo "Copied ${#INSTALLERS[@]} installer(s)."
else
  echo "No installer built yet — run 'pnpm build:installer' on Windows." >&2
fi

# Everything the assembler could not produce, stated plainly.
{
  echo "Submission folder assembly notes ($(date +%Y-%m-%d))"
  echo
  echo "Directory listing:"
  find "$SUBMISSION_DIR" -maxdepth 2 -mindepth 1 | sort | sed "s|$SUBMISSION_DIR|.|"
} > "$SUBMISSION_DIR/ASSEMBLY-NOTES.txt"

echo "Submission folder ready: $SUBMISSION_DIR"
