#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull
npm install
npm run build
pm2 restart lark-autoreply || pm2 start ecosystem.config.cjs
pm2 save

echo "Server updated and lark-autoreply is running."