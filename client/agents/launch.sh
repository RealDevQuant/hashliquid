#!/usr/bin/env bash
# Launch day: pauses the agents' service, runs the two launch rounds (6 forced entries), restarts the service.
#   agents/launch.sh          live
#   agents/launch.sh --dry    decide only, sign nothing
set -euo pipefail
cd "$(dirname "$0")/.."
PLIST="${HASHLIQUID_PLIST:-$HOME/Library/LaunchAgents/hashliquid-agents.plist}"   # the launchd job of the always-on service
launchctl unload "$PLIST" 2>/dev/null || true
# whatever happens below, the always-on service (and its guard) comes back
trap 'launchctl load "$PLIST" 2>/dev/null || true; echo "service back on"' EXIT
node agents/run.ts --launch "$@" 2>&1 | { grep -v "Warning\|trace-warnings" || true; }
