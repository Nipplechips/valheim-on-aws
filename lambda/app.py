import os
import logging
import awsgi
import boto3
from flask import Flask, jsonify, request
from discord_interactions import verify_key_decorator
from werkzerg.exceptions import InternalServerError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ec2_client = boto3.client('ec2')

public_key = os.environ.get("DISCORD_APP_PUBLIC_KEY")
instance_id = os.environ.get("INSTANCE_ID")

app = Flask(__name__)


@app.route('/prod/discord', methods=["POST"])
@verify_key_decorator(public_key)
def index():
    try:
        if request.json["type"] == 1:
            logger.info(f"Ping detected, returning type 1")
            return jsonify({"type": 1})
        # Parse request body
        body = request.json
        logger.info(f"BODY: {body}")
        options = body.get("data", {}).get("options", [])

        if not options or not isinstance(options, list) or "value" not in options[0]:
            raise HTTPException(status_code=400, detail="Invalid JSON structure")

        # Extract action
        action = options[0]["value"]

        # Perform the specified action
        if action == "start":
            response = ec2_client.start_instances(InstanceIds=[instance_id])
            message = "Instance starting"
        elif action == "stop":
            response = ec2_client.stop_instances(InstanceIds=[instance_id])
            message = "Instance stopping"
        elif action == "status":
            response = ec2_client.describe_instances(InstanceIds=[instance_id])
            state = response["Reservations"][0]["Instances"][0]["State"]["Name"]
            message = f"Server status: [ {state} ]"
        else:
            raise HTTPException(status_code=400, detail="Invalid action. Use 'start', 'stop', or 'status'.")
        logger.info(f"Returning message {message}")
        return jsonify({
            "type": 4,
            "data": {
                "tts": False,
                "content": message,
                "embeds": [],
                "allowed_mentions": {"parse": []}
            }
        })
    except ec2_client.exceptions.ClientError as e:
        logger.exception()
        raise InternalServerError(str(e))
    except Exception as e:
        logger.exception()
        raise InternalServerError(str(e))


def handler(event, context):
    # Alias old AWS event keys for this awsgi module
    logger.info(f"EVENT: {event}")
    event['httpMethod'] = event['requestContext']['http']['method']
    event['path'] = event['requestContext']['http']['path']
    event['queryStringParameters'] = event.get('queryStringParameters', {})
    return awsgi.response(
        app,
        event,
        context,
        base64_content_types={"image/png"}
    )
