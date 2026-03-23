#!/bin/sh
set -eu

mkdir -p /app/offchain-backend/data

npm run sync:markets
exec npm run start
