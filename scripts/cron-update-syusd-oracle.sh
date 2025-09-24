#!/bin/bash

# Cron wrapper script for sYUSD oracle updates
# This script runs every 8 hours to update sYUSD/YUSD exchange rates

# Configuration
PROJECT_DIR="/Users/michaelegorov/code/aegis/aegis-contracts"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/syusd-oracle-$(date +%Y%m%d).log"

# Create logs directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Function to log with timestamp
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Function to cleanup old logs (keep last 7 days)
cleanup_logs() {
    find "$LOG_DIR" -name "syusd-oracle-*.log" -mtime +7 -delete 2>/dev/null || true
}

log "🚀 Starting sYUSD Oracle Update (Cron Job)"
log "📂 Working directory: $PROJECT_DIR"
log "📝 Log file: $LOG_FILE"

# Change to project directory
cd "$PROJECT_DIR" || {
    log "❌ Failed to change to project directory: $PROJECT_DIR"
    exit 1
}

# Load environment variables from .env file if it exists
if [ -f ".env" ]; then
    log "📋 Loading environment variables from .env"
    export $(grep -v '^#' .env | xargs)
else
    log "⚠️  No .env file found, relying on system environment variables"
fi

# Check if PRIVATE_KEY is set
if [ -z "$PRIVATE_KEY" ]; then
    log "❌ PRIVATE_KEY environment variable not set"
    exit 1
fi

# Run the oracle update script
log "🔄 Running sYUSD oracle update script..."

# Run the script (macOS compatible)
npx hardhat run scripts/update-syusd-oracle.js --network mainnet 2>&1 | while IFS= read -r line; do
    log "$line"
done

# Check the exit status
EXIT_CODE=${PIPESTATUS[0]}

if [ $EXIT_CODE -eq 0 ]; then
    log "✅ sYUSD oracle update completed successfully"
else
    log "❌ sYUSD oracle update failed with exit code: $EXIT_CODE"
fi

# Cleanup old logs
cleanup_logs

log "🏁 Cron job finished with exit code: $EXIT_CODE"
echo "" >> "$LOG_FILE"  # Add blank line for readability

exit $EXIT_CODE
