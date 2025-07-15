#!/bin/bash
set -e

echo "Backing up Valheim world data"

aws s3 cp "/home/${username}/.config/unity3d/IronGate/Valheim/worlds_local/${world_name}.fwl" s3://${bucket}/
aws s3 cp "/home/${username}/.config/unity3d/IronGate/Valheim/worlds_local/${world_name}.db" s3://${bucket}/

aws s3 sync /tmp s3://${bucket}/dumps/ --include "*.txt"
aws s3 sync /home/${username}/Steam/logs s3://${bucket}/dumps/${username}/steam
sudo journalctl >> journal_dump.txt
aws s3 cp journal_dump.txt s3://${bucket}/dumps/journal_dump.txt




