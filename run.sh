#!/bin/sh
cd "$(dirname "$0")"
until node server.js >> server.log 2>&1; do sleep 2; done
