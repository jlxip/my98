#!/bin/sh
# Foreground supervisor for OpenBSD rc.d; no shell evaluation of configuration.
umask 077
child=
relay_stop() {
    trap '' TERM INT
    if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
    exit 0
}
trap relay_stop TERM INT
while :; do
    /usr/local/lib/my98-relay/my98-relay /etc/my98-relay/config.json &
    child=$!
    wait "$child"
    result=$?
    child=
    # Disabled configuration exits successfully; do not restart it.
    [ "$result" -eq 0 ] && exit 0
    sleep 3 &
    child=$!
    wait "$child"
    child=
done
