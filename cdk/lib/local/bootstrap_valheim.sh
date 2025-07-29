#!/bin/bash
set -e

# Get instance metadata for event
TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"` || true
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4) || true
PUBLIC_DNS=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-hostname) || true
export PUBLIC_IP PUBLIC_DNS

echo "Syncing startup script"

aws s3 cp s3://{{bucket}}/start_valheim.sh /home/{{username}}/valheim/start_valheim.sh
chmod +x /home/{{username}}/valheim/start_valheim.sh

bash /home/{{username}}/valheim/start_valheim.sh