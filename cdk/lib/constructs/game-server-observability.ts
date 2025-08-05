import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { LayerVersion, Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';

export interface GameServerObservationConstructProps {
    discordTokenKeyParam: string;
    autoScalingGroupName: string;
}
export class GameServerObservationConstruct extends Construct {
    public discordMessengerLambda: NodejsFunction;
    public discordMessageIdParam: ssm.StringParameter;
    constructor(scope: Construct, id: string, props: GameServerObservationConstructProps) {
        super(scope, id);

        // Create a Layer with Powertools for AWS Lambda (TypeScript)
        const powertoolsLayer = LayerVersion.fromLayerVersionArn(
            this,
            'PowertoolsLayer',
            `arn:aws:lambda:${cdk.Stack.of(this).region}:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:32`
        );

        this.discordMessageIdParam = new ssm.StringParameter(this, 'DiscordMessageIdParameter', {
            description: 'Stores the Discord message id that is representing server status',
            stringValue: ' ',
            tier: ssm.ParameterTier.STANDARD,
        });
        this.discordMessengerLambda = new NodejsFunction(this, 'DiscordMessengerFunction', {
            entry: 'lib/src/discord-interactions/messages/handler.ts',
            handler: "discordMessagingHandler",
            runtime: lambda.Runtime.NODEJS_22_X,
            layers: [powertoolsLayer],
            bundling: {
                externalModules: [
                    '@aws-lambda-powertools/*',
                    '@aws-sdk/*',
                ],
            },
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                DISCORD_APP_TOKEN_PARAM: `${props.discordTokenKeyParam}`,
                DISCORD_MESSAGE_ID_PARAM: this.discordMessageIdParam.parameterName,
                POWERTOOLS_SERVICE_NAME: 'discord-messaging',
                POWERTOOLS_METRICS_NAMESPACE: 'Valheim/Discord',
                LOG_LEVEL: 'DEBUG'
            }
        });

        // Add EC2 permissions to get instance details
        this.discordMessengerLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*']
        }));

        this.discordMessengerLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:PutParameter', 'ssm:GetParameter'],
            resources: [this.discordMessageIdParam.parameterArn]
        }));

        this.discordMessengerLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords'
            ],
            resources: ['*']
        }));

        this.discordMessengerLambda.addToRolePolicy(new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:GetParameter'],
                    resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${props.discordTokenKeyParam}`]
                }))

        // SNS Topic for notifications
        const topic = new sns.Topic(this, 'GameServerStatusTopic', {
            enforceSSL: true
        });

        // Ping SNS topic when 
        const shutdownAlarm = new cloudwatch.Alarm(this, 'GameServerStoppedAlarm', {
            alarmDescription: 'Scale down game server after period of inactivity',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/EC2',
                metricName: 'NetworkIn',
                statistic: 'Maximum',
                period: cdk.Duration.minutes(15) // Longer period to reduce API calls
            }),
            threshold: 50000,
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluationPeriods: 2, // Reduced evaluation periods
            datapointsToAlarm: 2,
            treatMissingData: cloudwatch.TreatMissingData.BREACHING
        });

        shutdownAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

        // EventBridge rule for ASG state changes
        const stateChangeRule = new events.Rule(this, 'GameServerStateChangeRule', {
            description: 'Trigger notifications when game server server starts',
            eventPattern: {
                source: events.Match.anyOf('aws.ec2', 'valheim'),
                detail: {
                    state: events.Match.exists()
                }
            }
        });

        stateChangeRule.addTarget(new targets.LambdaFunction(this.discordMessengerLambda));
        // stateChangeRule.addTarget(new targets.SnsTopic(topic, {
        //     message: events.RuleTargetInput.fromText(
        //         'At ${time}, GameServer server instance ${detail.EC2InstanceId} has launched in ASG ${detail.AutoScalingGroupName}.'
        //     )
        // }));

        // Allow SNS to trigger Lambda for auto-shutdown
        topic.addSubscription(new snsSubscriptions.LambdaSubscription(this.discordMessengerLambda));
    }
}