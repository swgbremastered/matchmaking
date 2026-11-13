#!/usr/bin/env bash
# Builds the matchmaking server's container image and, only when asked with --push, publishes it to a registry.
# The GitHub Actions workflow (.github/workflows/image.yml) does the same on every push to main; this is for a
# build by hand on a machine with Docker.
#
#   bash scripts/publish-image.sh [--push] [TAG]
#
#   TAG       default: <package.json version>-<git short hash>, e.g. 0.2.0-1a2b3c4d
#   --push    also `docker push` the TAG (never "latest": a compose file should name an exact tag)
#   env       REGISTRY (default ghcr.io/swgbremastered), IMAGE (default matchmaking),
#             NODE_IMAGE (default node:22-alpine; pin a digest for reproducible builds), PLATFORM (default linux/amd64)
#
# Log in to the registry first (docker login).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REGISTRY=${REGISTRY:-ghcr.io/swgbremastered}
IMAGE=${IMAGE:-matchmaking}
NODE_IMAGE=${NODE_IMAGE:-node:22-alpine}
PLATFORM=${PLATFORM:-linux/amd64}
PUSH=0
TAG=""
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) TAG=$a ;;
  esac
done
if [ -z "$TAG" ]; then
  VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json")
  REV=$(git -C "$HERE" rev-parse --short=8 HEAD 2>/dev/null || echo local)
  TAG="$VERSION-$REV"
fi
case "$TAG" in latest|"") echo "pick an exact tag (not latest)" >&2; exit 2 ;; esac
REF="$REGISTRY/$IMAGE:$TAG"
command -v docker > /dev/null || { echo "docker is not installed here" >&2; exit 1; }

# an image is only built from a tree whose tests pass
(cd "$HERE" && node --test --test-force-exit test/*.test.mjs > /dev/null) || { echo "server tests failed; no image" >&2; exit 1; }

echo "building $REF ($PLATFORM, from $NODE_IMAGE)"
docker build --pull --platform "$PLATFORM" --build-arg "NODE_IMAGE=$NODE_IMAGE" -t "$REF" "$HERE"
# smoke test: the image starts and answers its health check (plain mode, no certificate)
CID=$(docker run -d --rm -e SWGB_MM_CONFIG= "$REF" node src/server.mjs --db /data/smoke.db)
trap 'docker rm -f "$CID" > /dev/null 2>&1 || true' EXIT
for _ in $(seq 1 20); do
  if docker exec "$CID" wget -q -O - http://127.0.0.1:4318/health 2> /dev/null | grep -q '"ok":true'; then OK=1; break; fi
  sleep 1
done
[ "${OK:-0}" = 1 ] || { echo "the image did not answer its health check" >&2; docker logs "$CID" >&2; exit 1; }
echo "health check ok"

if [ "$PUSH" = 1 ]; then
  docker push "$REF"
  echo "pushed $REF"
  echo "compose: image: $REF"
else
  echo "built $REF (not pushed; run again with --push to publish it)"
fi
