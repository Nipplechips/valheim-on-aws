#!/bin/bash
set -e

echo "Syncing backup script"

aws s3 cp s3://{{bucket}}/backup_valheim.sh /home/{{username}}/valheim/backup_valheim.sh
chmod +x /home/{{username}}/valheim/backup_valheim.sh

echo "Setting crontab"

aws s3 cp s3://{{bucket}}/crontab /home/{{username}}/crontab
crontab < /home/{{username}}/crontab

echo "Preparing to start server"

export templdpath=$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=./linux64:$LD_LIBRARY_PATH
export SteamAppId=892970

echo "Checking if world files exist locally"

if [ ! -f "/home/{{username}}/.config/unity3d/IronGate/Valheim/worlds_local/{{world_name}}.fwl" ]; then
    echo "No world files found locally, checking if backups exist"
    BACKUPS=$(aws s3api head-object --bucket {{bucket}} --key "{{world_name}}.fwl" || true > /dev/null 2>&1)
    if [ -z "$${BACKUPS}" ]; then
        echo "No backups found using world name \"{{world_name}}\". A new world will be created."
    else
        echo "Backups found, restoring..."
        aws s3 cp "s3://{{bucket}}/" "/home/{{username}}/.config/unity3d/IronGate/Valheim/worlds_local/" --include "*.fwl" --include "*.db"aws 
    fi
else
    echo "World files found locally"
fi

echo "Syncing admin list"

aws s3 cp s3://{{bucket}}/adminlist.txt /home/{{username}}/.config/unity3d/IronGate/Valheim/adminlist.txt

echo "Starting server PRESS CTRL-C to exit"

./valheim_server.x86_64 -name "{{server_name}}" -port 2456 -world "{{world_name}}" -password {{server_password}} -batchmode -nographics -public 1

export LD_LIBRARY_PATH=$templdpath
