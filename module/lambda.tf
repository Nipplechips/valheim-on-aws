resource "aws_iam_role" "lambda_execution_role" {
  name = "lambda_execution_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "ec2_describe_instances_policy" {
  name   = "ec2_describe_instances_policy"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = [
          "ec2:DescribeInstances",
          "ec2:StartInstances",
          "ec2:StopInstances"
        ],
        Effect   = "Allow",
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_policy_attachment" "lambda_logs" {
  name       = "lambda_logs"
  roles      = [aws_iam_role.lambda_execution_role.name]
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy_attachment" "ec2_describe" {
  name       = "ec2_describe"
  roles      = [aws_iam_role.lambda_execution_role.name]
  policy_arn = aws_iam_policy.ec2_describe_instances_policy.arn
}

# resource "aws_lambda_layer_version" "valheim_server_control_layer" {
#   # TODO implement a better method of packaging the lambda layer
#   s3_bucket   = "lambda-layers-301332418406"
#   s3_key      = "valheim_server_control_layer.zip"
#   layer_name = "valheim_server_control_layer"
#   compatible_runtimes = ["python3.12"]
# }

resource "aws_lambda_function" "valheim_server_control" {
  # TODO implement a better method of packaging the lambda layer
  filename         = "../lambda/layer.zip"
  function_name    = "valheim_server_control"
  role             = aws_iam_role.lambda_execution_role.arn
  handler          = "app.handler"
  runtime          = "python3.12"
  source_code_hash = filebase64sha256("../lambda/layer.zip")
  # layers = [
  #   aws_lambda_layer_version.valheim_server_control_layer.arn
  # ]
  environment {
    variables = {
      DISCORD_APP_PUBLIC_KEY = var.discord_app_public_key
      INSTANCE_ID = aws_instance.valheim.id
    }
  }
}

# resource "aws_lambda_function_url" "api" {
#   function_name = aws_lambda_function.valheim_server_control.function_name
#   authorization_type = "NONE"
# }

resource "aws_apigatewayv2_api" "http_api" {
  name          = "Valheim Server Control API"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.valheim_server_control.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "discord" {
  api_id      = aws_apigatewayv2_api.http_api.id
  route_key   = "POST /discord"
  target      = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_stage" "prod" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "prod"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw_lambda" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.valheim_server_control.function_name
  principal     = "apigateway.amazonaws.com"
  # More: http://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
  source_arn = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}
