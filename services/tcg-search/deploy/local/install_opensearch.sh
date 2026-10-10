#!/usr/bin/env bash
# Install local single-node OpenSearch 3.x in WSL (services/tcg-search/OPS.md).
# Run as root:  sudo deploy/local/install_opensearch.sh
# Idempotent: re-running re-applies config and restarts the service.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

# 1. OpenSearch's signed apt repo (third-party repo, like PGDG for Postgres).
KEYRING=/usr/share/keyrings/opensearch-release-keyring
curl -fsSL https://artifacts.opensearch.org/publickeys/opensearch-release.pgp \
  | gpg --dearmor --yes -o "$KEYRING"
echo "deb [signed-by=$KEYRING] https://artifacts.opensearch.org/releases/bundle/opensearch/3.x/apt stable main" \
  > /etc/apt/sources.list.d/opensearch-3.x.list
apt-get update -q >/dev/null

# 2. Newest 3.x, then held so `apt upgrade` can't move it under the indices.
#    The package bundles its own JDK. Its demo-security postinst insists on an
#    admin password even though the security plugin is removed below; it is
#    random and never used.
if ! dpkg -s opensearch >/dev/null 2>&1; then
  VERSION=$(apt-cache policy opensearch | awk '/Candidate:/ {print $2}')
  echo "installing opensearch $VERSION"
  OPENSEARCH_INITIAL_ADMIN_PASSWORD="LocalOnly-$(openssl rand -hex 12)-Aa1!" \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q "opensearch=$VERSION" \
    >/tmp/opensearch-install.log 2>&1 || { tail -30 /tmp/opensearch-install.log; exit 1; }
fi
apt-mark hold opensearch >/dev/null

# 3. Remove plugins the search dev cluster doesn't use (dependents first).
#    Keeps: knn, index-management, job-scheduler, custom-codecs,
#    search-relevance, ubi, query-insights, system-templates.
systemctl stop opensearch 2>/dev/null || true
P=/usr/share/opensearch/bin/opensearch-plugin
for plugin in \
  opensearch-skills opensearch-flow-framework opensearch-neural-search \
  opensearch-security-analytics opensearch-anomaly-detection opensearch-alerting \
  opensearch-reports-scheduler opensearch-notifications opensearch-notifications-core \
  opensearch-ml opensearch-observability opensearch-performance-analyzer \
  opensearch-cross-cluster-replication opensearch-asynchronous-search \
  opensearch-geospatial opensearch-sql opensearch-ltr opensearch-security; do
  if "$P" list | grep -qx "$plugin"; then
    "$P" remove "$plugin" >/dev/null && echo "removed $plugin"
  fi
done

# 4. Config, heap, kernel setting.
install -m 0660 -o root -g opensearch "$HERE/opensearch.yml" /etc/opensearch/opensearch.yml
mkdir -p /etc/opensearch/jvm.options.d
install -m 0660 -o root -g opensearch "$HERE/heap.options" /etc/opensearch/jvm.options.d/heap.options
install -m 0644 "$HERE/99-opensearch.conf" /etc/sysctl.d/99-opensearch.conf
sysctl -q -p /etc/sysctl.d/99-opensearch.conf

# 5. Start and wait.
systemctl daemon-reload
systemctl enable --now opensearch >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -fs localhost:9200/_cluster/health >/dev/null && break
  sleep 2
done
curl -s 'localhost:9200/_cluster/health?pretty' | grep -E '"status"|number_of_nodes'
curl -s localhost:9200 | grep -E '"number"|lucene'
"$P" list | tr '\n' ' '; echo
echo "RSS: $(ps -o rss= -C java | awk '{s+=$1} END {print int(s/1024)" MB"}')"
