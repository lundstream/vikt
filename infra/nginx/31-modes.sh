#!/bin/sh
# Substitutes the deployment modes into the nginx config at container start
# (D94), the same way 30-app-name.sh substitutes the app name.
#
# The alternative is two config files and a symlink chosen by an entrypoint,
# which is more moving parts for one boolean.
set -eu

LANDING_ENABLED="${LANDING_ENABLED:-false}"
case "$LANDING_ENABLED" in
  true|1|yes) LANDING_ENABLED=true ;;
  *) LANDING_ENABLED=false ;;
esac

echo "31-modes.sh: landing page ${LANDING_ENABLED}"
sed -i "s|__LANDING_ENABLED__|${LANDING_ENABLED}|g" /etc/nginx/conf.d/default.conf
