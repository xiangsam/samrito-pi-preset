#!/usr/bin/env bash
# Build a distributable tarball of this bundle.
#
# For registry distribution prefer `npm publish`: it packs the bundled
# dependencies (see "bundledDependencies" in package.json) so the target machine
# can run `pi install npm:samrito-pi-preset`. This script instead produces a plain
# source tarball for copying a checkout to another machine.
#
# The tarball carries the extension collection and config templates but not
# node_modules unless --with-deps is given.
#
# Note: a tarball path is NOT a valid `pi install` source — pi treats a local
# path that is a file as a single extension. Extract it on the target machine
# first, then install the extracted directory.
#
# Usage: bash scripts/pack.sh [--with-deps] [--skip-verify]
#   --with-deps     bundle node_modules too, for a fully offline install
#   --skip-verify   pack even if verification fails (e.g. this machine's own
#                   settings.json conflicts; the target machine has its own)

set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_ROOT"

WITH_DEPS=0
SKIP_VERIFY=0
for arg in "$@"; do
	case "$arg" in
		--with-deps) WITH_DEPS=1 ;;
		--skip-verify) SKIP_VERIFY=1 ;;
		-h | --help)
			sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown option: $arg" >&2
			exit 1
			;;
	esac
done

if [ ! -d node_modules ]; then
	echo "node_modules is missing; run: node scripts/setup.mjs" >&2
	exit 1
fi

echo "==> syncing pi.extensions"
node scripts/sync-manifest.mjs >/dev/null

if [ "$SKIP_VERIFY" -eq 1 ]; then
	echo "==> verifying (skipped)"
else
	echo "==> verifying"
	if ! node scripts/verify.mjs; then
		cat >&2 <<'EOF'

Packing stopped: verification failed.

If the failure is only "startup conflicts" against this machine's settings.json,
that describes the local pi install, not the tarball contents — the target
machine has its own settings.json. Re-run with --skip-verify to pack anyway.
EOF
		exit 1
	fi
fi

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
ARCHIVE="${NAME}-${VERSION}.tar.gz"

# tar with a portable include list (macOS ships bsdtar, which lacks --transform
# semantics on some versions, so assemble in a staging dir instead).
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/$NAME"

INCLUDE=(package.json README.md config scripts .gitignore)
[ -f package-lock.json ] && INCLUDE+=(package-lock.json)
if [ "$WITH_DEPS" -eq 1 ]; then
	INCLUDE+=(node_modules)
fi

for item in "${INCLUDE[@]}"; do
	[ -e "$item" ] && cp -R "$item" "$STAGING/$NAME/"
done

echo
if [ "$WITH_DEPS" -eq 1 ]; then
	echo "==> packing ${ARCHIVE} (including node_modules)"
else
	echo "==> packing ${ARCHIVE} (without node_modules)"
fi
tar -czf "$ARCHIVE" -C "$STAGING" "$NAME"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "created ${ARCHIVE} (${SIZE})"
echo
echo "On the target machine:"
echo "  tar -xzf ${ARCHIVE}"
echo "  cd ${NAME} && node scripts/setup.mjs"
echo "  pi install \"\$PWD\""
