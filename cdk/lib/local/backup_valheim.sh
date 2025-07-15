#!/bin/bash
set -e

echo "Backing up Valheim world data"

aws s3 sync "/home/{{username}}/.config/unity3d/IronGate/Valheim/worlds_local/" s3://{{bucket}}/ --include "*.fwl" --include "*.db" --no-follow-symlinks || echo "No world data found to backup"