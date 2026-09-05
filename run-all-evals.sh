#!/bin/bash
# Regenerate every artifact from one simulator version, in order.
# Split from the report generator so the sequence is visible and resumable.
set -e
cd /Users/skep/Documents/baaki
export PATH="/opt/homebrew/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a

echo "=== waiting for the prior experiment to finish ==="
while pgrep -f "agent-delta" > /dev/null; do sleep 20; done
echo "  done"

echo "=== 1/3  headline report (10 seeds, 144-cell grid) ==="
npx tsx packages/evals/src/report.ts

echo "=== 2/3  comprehension sweep ==="
npx tsx packages/evals/src/comprehension-sweep.ts

echo "=== 3/3  reply understanding (cached, free) ==="
npx tsx packages/evals/src/reply-eval.ts || echo "  (skipped: needs GEMINI_API_KEY)"

echo
echo "=== every artifact, one simulator version ==="
grep -l "Simulator" evals/*.md 2>/dev/null | while read f; do
  printf "  %-28s " "$(basename $f)"
  grep -o 's[0-9]\+' "$f" | head -1
done
echo "ALL EVALS DONE"
