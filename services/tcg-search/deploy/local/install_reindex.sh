#!/usr/bin/env bash
# Install the nightly catalog reindex (services/tcg-search/OPS.md §4).
#   sudo deploy/local/install_reindex.sh [SERVICE_DIR] [USER]
# SERVICE_DIR defaults to the services/tcg-search this script lives in (it
# must have a .venv: `make install`); USER defaults to $SUDO_USER.
# Re-run after moving the checkout. Never edits mtg-prices-daily.service or
# its script: it only adds a drop-in next to them.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SERVICE_DIR=${1:-$(cd "$HERE/../.." && pwd)}
RUN_AS=${2:-${SUDO_USER:-$(id -un)}}
[ -x "$SERVICE_DIR/.venv/bin/python" ] || { echo "no $SERVICE_DIR/.venv (run make install)" >&2; exit 1; }

sed -e "s#@SERVICE_DIR@#$SERVICE_DIR#g" -e "s#@USER@#$RUN_AS#g" \
  "$HERE/tcg-search-reindex.service" > /etc/systemd/system/tcg-search-reindex.service
chmod 0644 /etc/systemd/system/tcg-search-reindex.service
install -d /etc/systemd/system/mtg-prices-daily.service.d
install -m 0644 "$HERE/mtg-prices-daily.service.d/search.conf" \
  /etc/systemd/system/mtg-prices-daily.service.d/search.conf
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/tcg-search-reindex.service
systemctl show mtg-prices-daily.service -p OnSuccess
echo "installed; test with: sudo systemctl start tcg-search-reindex && journalctl -u tcg-search-reindex -n 20"
