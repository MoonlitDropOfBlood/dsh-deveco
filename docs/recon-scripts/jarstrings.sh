#!/usr/bin/env bash
# Extract printable ASCII strings from every class/resource entry of a jar and grep.
# usage: jarstrings.sh <jar> <regex> [maxhits]
set -u
jar="$1"; pat="$2"; max="${3:-60}"
tmp=$(mktemp -d)
unzip -qo "$jar" -d "$tmp" 2>/dev/null
hits=0
while IFS= read -r f; do
  out=$(tr -c '[:print:]' '\n' < "$f" | grep -aE "$pat" | sort -u)
  if [ -n "$out" ]; then
    echo "### ${f#$tmp/}"
    echo "$out" | head -20
    hits=$((hits+1))
    [ "$hits" -ge "$max" ] && break
  fi
done < <(find "$tmp" -type f \( -name '*.class' -o -name '*.xml' -o -name '*.properties' -o -name '*.json' -o -name '*.js' \))
rm -rf "$tmp"
