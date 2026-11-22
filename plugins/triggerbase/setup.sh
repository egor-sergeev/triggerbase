#!/bin/sh
# Bootstrap with stock macOS tools. All runner and service logic runs in Node.
set -eu
umask 077
[ "$(/usr/bin/uname -s)" = Darwin ] || { echo "Triggerbase requires macOS." >&2; exit 1; }
plugin=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
base=${TRIGGERBASE_HOME:+"$TRIGGERBASE_HOME/install"}
base=${base:-"$HOME/.local/share/triggerbase"}
version=v24.22.3
case "$(/usr/bin/uname -m)" in
  arm64) arch=arm64; digest=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
  x86_64) arch=x64; digest=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
  *) echo "Unsupported Mac architecture." >&2; exit 1 ;;
esac
package=node-$version-darwin-$arch
runtime="$base/runtimes/$package"
if [ ! -x "$runtime/bin/node" ]; then
  mkdir -p "$base/runtimes"
  stage=$(mktemp -d "$base/runtimes/.install.XXXXXXXX")
  trap 'rm -rf "$stage"' EXIT
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 \
    "https://nodejs.org/dist/$version/$package.tar.gz" -o "$stage/node.tar.gz"
  (cd "$stage" && printf '%s  node.tar.gz\n' "$digest" | /usr/bin/shasum -a 256 -c -)
  /usr/bin/tar -xzf "$stage/node.tar.gz" -C "$stage" "$package/bin/node" "$package/LICENSE"
  # rename(2) publishes one complete runtime even when both hosts install together.
  "$stage/$package/bin/node" -e '
    try { require("node:fs").renameSync(process.argv[1], process.argv[2]); }
    catch (err) { if (!["EEXIST","ENOTEMPTY"].includes(err.code)) throw err; }
  ' "$stage/$package" "$runtime"
  rm -rf "$stage"
  trap - EXIT
fi
exec "$runtime/bin/node" "$plugin/bin/setup.mts" "$base"
