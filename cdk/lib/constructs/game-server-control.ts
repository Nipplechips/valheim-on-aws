import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { CfnAccount } from 'aws-cdk-lib/aws-apigateway';
import { NagSuppressions } from 'cdk-nag/lib/nag-suppressions';


export interface GameServerControlConstructProps {
    gameServerControl: {
        name: string;
        arn: string;
    }
    discordAppPublicKey?: string;
    discordAppId?: string;
    discordToken?: string;
    launchArgsParameter: ssm.StringParameter;
    discordMessageIdParameter: ssm.StringParameter;
}
export class GameServerControlConstruct extends Construct {
    public discordInteractionLambda: NodejsFunction;
    public discordCommandRegistrationLambda: NodejsFunction;

    constructor(scope: Construct, id: string, props: GameServerControlConstructProps) {
        super(scope, id);

        // Lambda for Discord bot
        const lambdaRole = new iam.Role(this, 'LambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
            ]
        });

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: [`arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`]
        }));


        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:DeleteParameter'],
            resources: [`${props.discordMessageIdParameter.parameterArn}`]
        }));
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:PutParameter'],
            resources: [`${props.launchArgsParameter.parameterArn}`]
        }));

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'autoscaling:DescribeAutoScalingGroups',
                'autoscaling:SetDesiredCapacity'
            ],
            resources: [props.gameServerControl.arn]
        }));

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords'
            ],
            resources: ['*']
        }));


        // Create a Layer with Powertools for AWS Lambda (TypeScript)
        const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
            this,
            'PowertoolsLayer',
            `arn:aws:lambda:${cdk.Stack.of(this).region}:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:32`
        );
        const logGroupDiscordBotFunction = new logs.LogGroup(this, 'DiscordBotFunctionLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        this.discordInteractionLambda = new NodejsFunction(this, 'DiscordBotFunction', {
            entry: 'lib/src/discord-interactions/interactions/handler.ts',
            handler: "discordBotHandler",
            runtime: lambda.Runtime.NODEJS_22_X,
            layers: [powertoolsLayer],
            bundling: {
                externalModules: [
                    '@aws-lambda-powertools/*',
                    '@aws-sdk/*',
                ],
            },
            architecture: lambda.Architecture.ARM_64,
            role: lambdaRole,
            logGroup: logGroupDiscordBotFunction,
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                DISCORD_APP_PUBLIC_KEY: `${props.discordAppPublicKey}`,
                LAUNCH_ARGS_PARAM_NAME: `${props.launchArgsParameter.parameterName}`,
                DISCORD_MESSAGE_ID_PARAM_NAME: `${props.discordMessageIdParameter.parameterName}`,
                ASG_NAME: props.gameServerControl.name,
                POWERTOOLS_SERVICE_NAME: 'discord-interactions',
                POWERTOOLS_METRICS_NAMESPACE: 'Valheim/Discord',
                POWERTOOLS_LOG_LEVEL: "DEBUG"
            }
        });

        // const logGroupRegisterDiscordCommand = new logs.LogGroup(this, 'RegisterDiscordCommandLogs', {
        //     retention: logs.RetentionDays.ONE_WEEK,
        //     removalPolicy: cdk.RemovalPolicy.DESTROY
        // });

        // new NodejsFunction(this, 'DiscordRegisterCommandFunction', {
        //     entry: 'lib/src/discord-interactions/messages/handler.ts',
        //     handler: "discordMessagingHandler",
        //     runtime: lambda.Runtime.NODEJS_LATEST,
        //     logGroup: logGroupRegisterDiscordCommand,
        //     environment: {
        //         DISCORD_APP_PUBLIC_KEY: `${props.discordAppPublicKey}`,
        //         DISCORD_APP_ID: `${props.discordAppId}`,
        //         DISCORD_TOKEN: `${props.discordToken}`
        //     }
        // });

        this.makeApiGateway();
    }

    private makeApiGateway() {

        // Create a role for API Gateway to write logs to CloudWatch
        const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
            ]
        });

        // API Gateway
        // Enable API Gateway to push logs to CloudWatch
        const apiGatewayAccountSettings = new CfnAccount(this, 'ApiGatewayAccountSettings', {
            cloudWatchRoleArn: apiGatewayLoggingRole.roleArn
        });

        const logGroup = new logs.LogGroup(this, 'ValheimApiLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });

        const httpApi = new apigateway.CfnApi(this, 'ValheimApi', {
            name: 'Valheim Server Control API',
            protocolType: 'HTTP'
        });

        // Configure API Gateway logging
        const stage = new apigateway.CfnStage(this, 'ValheimApiStage', {
            apiId: httpApi.ref,
            stageName: '$default',
            autoDeploy: true,
            accessLogSettings: {
                destinationArn: logGroup.logGroupArn,
                format: JSON.stringify({
                    requestId: '$context.requestId',
                    ip: '$context.identity.sourceIp',
                    requestTime: '$context.requestTime',
                    httpMethod: '$context.httpMethod',
                    routeKey: '$context.routeKey',
                    status: '$context.status',
                    protocol: '$context.protocol',
                    responseLength: '$context.responseLength',
                    userAgent: '$context.identity.userAgent',
                    integrationError: '$context.integrationErrorMessage',
                    integrationLatency: '$context.integrationLatency',
                    integrationStatus: '$context.integrationStatus',
                    extendedRequestId: "$context.extendedRequestId",
                    caller: "$context.identity.caller",
                    user: "$context.identity.user",
                    resourcePath: "$context.resourcePath",
                    requestBody: '$input.body',
                })
            }
        });

        // Ensure the stage is created after the account settings
        stage.addDependency(apiGatewayAccountSettings);

        const integration = new apigateway.CfnIntegration(this, 'LambdaIntegration', {
            apiId: httpApi.ref,
            integrationType: 'AWS_PROXY',
            integrationUri: this.discordInteractionLambda.functionArn,
            payloadFormatVersion: '2.0'
        });

        const route = new apigateway.CfnRoute(this, 'DiscordRoute', {
            apiId: httpApi.ref,
            routeKey: 'POST /interactions',
            target: `integrations/${integration.ref}`
        });

        new lambda.CfnPermission(this, 'ApiGatewayInvoke', {
            action: 'lambda:InvokeFunction',
            functionName: this.discordInteractionLambda.functionName,
            principal: 'apigateway.amazonaws.com',
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${httpApi.ref}/*/*`
        });

        // Suppress log group encryption warning if needed
        NagSuppressions.addResourceSuppressions(logGroup, [{
            id: "AwsSolutions-L1",
            reason: "Log group encryption is not required for this development API"
        }]);
        NagSuppressions.addResourceSuppressions(route, [{
            id: "AwsSolutions-APIG4",
            reason: "This route does not require authorization until the game server is working"
        }]);
    }
}