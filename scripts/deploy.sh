#!/bin/bash
set -euo pipefail

# Config
REMOTE_USER=${REMOTE_USER:-deploy}
REMOTE_HOST=${REMOTE_HOST:?Set REMOTE_HOST}
REMOTE_DIR=${REMOTE_DIR:-/opt/twitter-intel-digest}
SERVICE_NAME=twitter-intel

echo "Building..."
npm run build

echo "Syncing to $REMOTE_HOST..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude '*.db*' \
  --exclude .git \
  dist/ package.json package-lock.json config.yaml \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

echo "Installing deps on remote..."
ssh "$REMOTE_USER@$REMOTE_HOST" "cd $REMOTE_DIR && npm ci --production"

echo "Restarting service..."
ssh "$REMOTE_USER@$REMOTE_HOST" "sudo systemctl restart $SERVICE_NAME"

echo "Checking status..."
sleep 2
ssh "$REMOTE_USER@$REMOTE_HOST" "sudo systemctl status $SERVICE_NAME --no-pager"

echo "Deploy complete ✓"
