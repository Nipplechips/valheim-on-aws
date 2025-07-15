#!/bin/bash
set -e

echo "Syncing startup script"

# Retry S3 download with backoff
for i in {1..5}; do
    if aws s3 cp s3://${bucket}/start_valheim.sh /home/${username}/valheim/start_valheim.sh; then
        chmod +x /home/${username}/valheim/start_valheim.sh
        break
    else
        echo "Attempt $i failed, retrying in 30 seconds..."
        sleep 30
    fi
done

bash /home/${username}/valheim/start_valheim.sh
