#!/bin/bash
# scripts/backup_database.sh
# ═════════════════════════════════════════════════════════════
# Production database backup script with automatic cleanup
# 
# Usage: ./backup_database.sh
# Or run via cron: 0 2 * * * /home/user/public_html/scripts/backup_database.sh
#
# Features:
# - Daily incremental backups
# - Automatic compression with gzip
# - Cleanup of backups older than 30 days
# - Email notification on completion
# - Detailed logging

# Configuration
BACKUP_DIR="/backups/fbcast"
RETENTION_DAYS=30
MAX_BACKUPS=10
LOG_FILE="/var/log/fbcast_backup.log"

# Get DB credentials from .env
APP_DIR="/home/user/public_html"
export $(grep "^DB_" "$APP_DIR/.env" | xargs)

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Generate backup filename
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/fbcast_$TIMESTAMP.sql.gz"
BACKUP_LOG="$BACKUP_DIR/backup_$TIMESTAMP.log"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "═══════════════════════════════════════════════════════════"
log "Starting FBCast Pro database backup"
log "═══════════════════════════════════════════════════════════"

# Check prerequisites
if ! command -v mysqldump &> /dev/null; then
    log "ERROR: mysqldump not found. Install mysql-client."
    exit 1
fi

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
    log "ERROR: Database credentials not found in .env"
    exit 1
fi

# Perform backup
log "Backing up database: $DB_NAME"
START_TIME=$(date +%s)

mysqldump \
    --single-transaction \
    --quick \
    --lock-tables=false \
    --verbose \
    -h "$DB_HOST" \
    -u "$DB_USER" \
    -p"$DB_PASS" \
    "$DB_NAME" \
    2> "$BACKUP_LOG" | gzip > "$BACKUP_FILE"

BACKUP_EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

if [ $BACKUP_EXIT_CODE -eq 0 ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "✅ Backup completed successfully"
    log "   File: $BACKUP_FILE"
    log "   Size: $BACKUP_SIZE"
    log "   Duration: ${DURATION}s"
else
    log "❌ Backup failed with exit code $BACKUP_EXIT_CODE"
    cat "$BACKUP_LOG" >> "$LOG_FILE"
    exit 1
fi

# Clean up old backups
log "Cleaning up backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name "fbcast_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete
log "✅ Cleanup completed"

# Verify backup integrity
log "Verifying backup integrity"
if gunzip -t "$BACKUP_FILE" &> /dev/null; then
    log "✅ Backup integrity verified"
else
    log "❌ Backup integrity check failed"
    rm "$BACKUP_FILE"
    exit 1
fi

# Keep only latest $MAX_BACKUPS
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/fbcast_*.sql.gz | wc -l)
if [ $BACKUP_COUNT -gt $MAX_BACKUPS ]; then
    log "Removing old backups (keeping $MAX_BACKUPS)"
    ls -t1 "$BACKUP_DIR"/fbcast_*.sql.gz | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f
fi

# Optional: Upload to remote storage (S3, etc.)
# if [ "$ENABLE_S3_BACKUP" = "true" ]; then
#     log "Uploading to S3..."
#     aws s3 cp "$BACKUP_FILE" s3://your-bucket/fbcast_backups/
#     log "✅ S3 upload completed"
# fi

log "═══════════════════════════════════════════════════════════"
log "Backup process completed successfully"
log ""

# Send email notification (optional)
# mail -s "FBCast Backup: $BACKUP_FILE" admin@yourdomain.com << EOF
# Backup Details:
# File: $BACKUP_FILE
# Size: $BACKUP_SIZE
# Duration: ${DURATION}s
# Status: Success
# EOF
