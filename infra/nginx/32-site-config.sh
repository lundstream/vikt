#!/bin/sh
# Runs from the nginx image's own entrypoint directory, after 30 and 31.
#
# Fills in who runs this installation (D121). `vite build` leaves the literal
# tokens in index.html; this rewrites them from the environment, so the operator's
# address is a deployment setting rather than something in the source. Under the
# GDPR the person who deploys Vikt is the controller, not the person who wrote
# it, so this cannot be a constant in a repository.
#
# Only `*.html`, deliberately, and only these tokens. The JavaScript bundles
# carry content hashes that the service worker's precache manifest records, so
# rewriting bytes inside one would leave the worker refusing its own cache.
# `check-placeholders.mjs` fails the build if one of these lands anywhere this
# script will not reach.
set -eu

ROOT=/usr/share/nginx/html

CONTACT_EMAIL="${CONTACT_EMAIL:-}"
OPERATOR="${OPERATOR:-}"
REPO_URL="${REPO_URL:-https://github.com/lundstream/vikt}"
SUPPORT_URL="${SUPPORT_URL:-}"
# Where this installation answers, for the share card's absolute URLs (D173).
# Empty leaves a root-relative path, which is wrong for a scraper and harmless
# for a browser, and is the right failure for an installation that has not said
# what it is called.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

if [ -z "$CONTACT_EMAIL" ]; then
  # Not fatal here: the API refuses to boot without it where a landing page is
  # served, which is the right place to fail. nginx serving the app to somebody
  # already signed in is not the failure worth stopping.
  echo "32-site-config.sh: CONTACT_EMAIL is not set; the privacy page will name no address"
else
  echo "32-site-config.sh: contact ${CONTACT_EMAIL}"
fi

# `|` as the delimiter, because every one of these values can contain a slash.
find "$ROOT" -type f -name '*.html' -exec sed -i \
  -e "s|__CONTACT_EMAIL__|${CONTACT_EMAIL}|g" \
  -e "s|__OPERATOR__|${OPERATOR}|g" \
  -e "s|__REPO_URL__|${REPO_URL}|g" \
  -e "s|__SUPPORT_URL__|${SUPPORT_URL}|g" \
  -e "s|__PUBLIC_BASE_URL__|${PUBLIC_BASE_URL}|g" \
  {} +
