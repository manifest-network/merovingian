#!/bin/sh
# Keep PORT consistent with the app; curl owns HTTP parsing and timeout handling.
port=${PORT:-8080}
case "$port" in *[!0-9]*) exit 1 ;; esac
[ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || exit 1

status=$(curl --disable --silent --fail --noproxy '*' --proto '=http' \
    --max-time 4 --max-filesize 65536 --output /dev/null --write-out '%{http_code}' \
    "http://127.0.0.1:$port/healthz") || {
    result=$?
    [ "$result" -ge 126 ] && exit "$result"
    exit 1
}
case "$status" in 2[0-9][0-9]) exit 0 ;; *) exit 1 ;; esac
