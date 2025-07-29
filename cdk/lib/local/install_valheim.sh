#!/bin/bash
set -e

echo "Installing Valheim server"

mkdir -p /home/{{username}}/steam && cd /home/{{username}}/steam || exit
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -

/home/{{username}}/steam/steamcmd.sh +force_install_dir /home/{{username}}/valheim +login anonymous +app_update 896660 validate +quit

echo "Verifying Valheim server installation..."
if [ -f "/home/{{username}}/valheim/valheim_server.x86_64" ]; then
    echo "SUCCESS: Valheim server binary found"
    aws events put-events --region eu-west-2 --entries "[{\"Source\":\"valheim\",\"DetailType\":\"Steam Client Installed\",\"Detail\":\"{\\\"dnsName\\\":\\\"$PUBLIC_DNS\\\",\\\"state\\\":\\\"steam_installed\\\"}\"}]"
else
    echo "ERROR: Valheim server binary not found"
    exit 1
fi
