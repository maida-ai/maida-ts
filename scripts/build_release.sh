#!/usr/bin/env bash
# Package only committed source from the exact release commit.
set -euo pipefail

if [[ ! "${GITHUB_REF:-}" =~ ^refs/tags/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$ ]]; then
  echo '::error::Release builds require vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N.' >&2
  exit 2
fi
version="${GITHUB_REF#refs/tags/v}"
prerelease=false
if [[ -n "${BASH_REMATCH[4]}" ]]; then
  prerelease=true
fi
if [[ ! "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || [[ "$(git rev-parse HEAD)" != "$GITHUB_SHA" ]]; then
  echo '::error::Checkout does not match the release event commit.' >&2
  exit 2
fi
package_version="$(git show "$GITHUB_SHA:package.json" | node -e "let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(data).version))")"
if [[ "$package_version" != "$version" ]]; then
  echo "::error::Tag v$version does not match package.json version $package_version." >&2
  exit 2
fi
lock_version="$(git show "$GITHUB_SHA:package-lock.json" | node -e "let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(data).packages[''].version))")"
if [[ "$lock_version" != "$version" ]]; then
  echo "::error::Tag v$version does not match package-lock.json version $lock_version." >&2
  exit 2
fi

output="${1:?Pass the release output directory}"
mkdir -p "$output"
git archive --format=tar --prefix=maida-ts/ "$GITHUB_SHA" | gzip -n > "$output/maida-ts.tar.gz"
(
  cd "$output"
  sha256sum maida-ts.tar.gz > SHA256SUMS
  sha256sum --check SHA256SUMS
)
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'prerelease=%s\n' "$prerelease" >> "$GITHUB_OUTPUT"
fi
