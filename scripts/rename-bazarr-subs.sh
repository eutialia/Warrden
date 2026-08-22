#!/usr/bin/env bash
# Bazarr writes Chinese sidecars as bare <stem>.zh.srt / <stem>.zh.hi.srt. Jellyfin
# reads bare `zh` as script-less generic Chinese, and Warrden only counts zh-Hans /
# zh-Hant. This retags each file's `.zh.` segment with the script it actually contains,
# leaving any Jellyfin flag segments (hi, sdh, forced, default) after it untouched.
set -eu

usage() {
  cat <<'EOF'
Usage: rename-bazarr-subs.sh [--apply] DIR...

Renames *.zh.srt / *.zh.ass / *.zh.ssa sidecars (and the same with hi/sdh/forced/default
flag segments after zh, in any order) under each DIR to zh-Hans or zh-Hant, based on a
fixed set of Traditional-only characters found in the file.

Without --apply, prints what would be renamed and a tally, and changes nothing.
With --apply, performs the renames.

Already-tagged files (zh-Hans, zh-Hant) are left alone, so this is safe to run again.
EOF
}

APPLY=0
DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      DIRS+=("$1")
      shift
      ;;
  esac
done

if [ ${#DIRS[@]} -eq 0 ]; then
  usage >&2
  exit 1
fi

if [ -z "${LC_ALL:-}" ]; then
  if locale -a 2>/dev/null | grep -qi '^C\.UTF-8$'; then
    export LC_ALL=C.UTF-8
  elif locale -a 2>/dev/null | grep -qi '^en_US\.UTF-8$'; then
    export LC_ALL=en_US.UTF-8
  fi
fi

TRAD_CHARS='們這說來時過後為國學會對還沒種樣裡發經點麼開關體書長東車門見馬魚鳥風雲電龍華'

hans_count=0
hant_count=0
skip_count=0

# Parses a basename of the form <stem>.zh[.<flag>...].<ext>, peeling known flag
# segments (hi, sdh, forced, default) off the end until it either hits the `zh`
# segment or hits something else and gives up. Sets the globals `match`, `stem`,
# `ext`, and `flags` (dot-joined, in their original left-to-right order, empty if
# none). Kept as a string rather than an array: bash 3.2 treats `${arr[@]}` on a
# still-empty array as unbound under `set -u`.
classify_name() {
  local fname="$1"
  ext="${fname##*.}"
  local seg="${fname%.*}"
  local last newseg
  flags=""
  match=0
  while :; do
    last="${seg##*.}"
    if [ "$last" = "zh" ]; then
      if [ "$seg" = "zh" ]; then
        stem=""
      else
        stem="${seg%.*}"
      fi
      match=1
      return
    fi
    case "$last" in
      hi | sdh | forced | default)
        flags="$last${flags:+.$flags}"
        newseg="${seg%.*}"
        [ "$newseg" = "$seg" ] && return
        seg="$newseg"
        ;;
      *)
        return
        ;;
    esac
  done
}

for dir in "${DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "not a directory: $dir" >&2
    exit 1
  fi

  while IFS= read -r -d '' file; do
    fname="$(basename -- "$file")"
    classify_name "$fname"
    [ "$match" -eq 1 ] || continue
    case "$ext" in
      srt | ass | ssa) ;;
      *) continue ;;
    esac

    if grep -q "[$TRAD_CHARS]" -- "$file" 2>/dev/null; then
      lang=zh-Hant
    else
      lang=zh-Hans
    fi

    if [ -z "$flags" ]; then
      newname="${stem}.${lang}.${ext}"
    else
      newname="${stem}.${lang}.${flags}.${ext}"
    fi

    dest="$(dirname -- "$file")/${newname}"

    if [ -e "$dest" ]; then
      echo "skip (exists): $file"
      skip_count=$((skip_count + 1))
      continue
    fi

    if [ "$lang" = "zh-Hant" ]; then
      hant_count=$((hant_count + 1))
    else
      hans_count=$((hans_count + 1))
    fi

    if [ "$APPLY" -eq 1 ]; then
      mv -- "$file" "$dest"
      echo "renamed: $file -> $dest"
    else
      echo "would rename: $file -> $dest"
    fi
  done < <(find "$dir" -type f -name '*.zh.*' -print0)
done

echo "${hans_count} -> zh-Hans, ${hant_count} -> zh-Hant, ${skip_count} skipped (exists)"
exit 0
