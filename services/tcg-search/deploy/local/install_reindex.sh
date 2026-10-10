#!/usr/bin/env bash
# Install the nightly catalog reindex and the listings follower
# (services/tcg-search/OPS.md §4–5).
#   sudo deploy/local/install_reindex.sh [SERVICE_DIR] [USER] [POS_DIR]
# SERVICE_DIR defaults to the services/tcg-search this script lives in,
# POS_DIR to its sibling services/tcg-pos-api; both must have a .venv
# (`make install`). USER defaults to $SUDO_USER. Re-run after moving the
# checkout. Never edits mtg-prices-daily.service or its script: it only adds
# a drop-in next to them.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SERVICE_DIR=${1:-$(cd "$HERE/../.." && pwd)}
RUN_AS=${2:-${SUDO_USER:-$(id -un)}}
POS_DIR=${3:-$(cd "$SERVICE_DIR/../tcg-pos-api" && pwd)}
[ -x "$SERVICE_DIR/.venv/bin/python" ] || { echo "no $SERVICE_DIR/.venv (run make install)" >&2; exit 1; }
[ -x "$POS_DIR/.venv/bin/python" ] || { echo "no $POS_DIR/.venv (run make install there)" >&2; exit 1; }

for unit in tcg-search-reindex.service tcg-search-listings.service; do
  sed -e "s#@SERVICE_DIR@#$SERVICE_DIR#g" -e "s#@POS_DIR@#$POS_DIR#g" -e "s#@USER@#$RUN_AS#g" \
    "$HERE/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
install -d /etc/systemd/system/mtg-prices-daily.service.d
install -m 0644 "$HERE/mtg-prices-daily.service.d/search.conf" \
  /etc/systemd/system/mtg-prices-daily.service.d/search.conf
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/tcg-search-reindex.service \
  /etc/systemd/system/tcg-search-listings.service
systemctl show mtg-prices-daily.service -p OnSuccess
systemctl enable tcg-search-listings.service
systemctl restart tcg-search-listings.service
echo "installed; reindex: sudo systemctl start tcg-search-reindex && journalctl -u tcg-search-reindex -n 20"
echo "listings follower: journalctl -u tcg-search-listings -f"
