import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';
import * as fs from 'fs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { CfnAccount } from 'aws-cdk-lib/aws-apigateway';

export interface ValheimStackProps extends cdk.StackProps {
  admins: { [key: string]: string };
  awsRegion: string;
  awsAccountId: string;
  domain?: string;
  instanceType: string;
  pgpKey: string;
  purpose: string;
  s3LifecycleExpiration: string;
  serverName: string;
  serverPassword: string;
  snsEmail: string;
  uniqueId?: string;
  worldName: string;
  discordAppPublicKey: string;
  // Cost optimization options
  maxSpotPrice?: number; // Maximum spot price per hour
  useSpotInstances?: boolean; // Enable/disable spot instances
  ebsVolumeSize?: number; // EBS volume size in GB
}

export class ValheimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ValheimStackProps) {
    super(scope, id, props);

    const username = 'vhserver';
    const name = props.purpose !== 'prod' ? `valheim-${props.purpose}${props.uniqueId || ''}` : 'valheim';
    const useDomain = props.domain && props.domain !== '';

    const tags = {
      Purpose: props.purpose,
      Component: 'Valheim Server',
      CreatedBy: 'CDK'
    };

    // S3 Bucket for backups and scripts
    const bucket = new s3.Bucket(this, 'ValheimBucket', {
      bucketName: `${name}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        id: 'OptimizeBackupStorage',
        enabled: true,
        transitions: [
          {
            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            transitionAfter: cdk.Duration.days(0) // Immediate intelligent tiering
          },
          {
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(30) // Archive old backups
          }
        ],
        expiration: cdk.Duration.days(parseInt(props.s3LifecycleExpiration))
      }, {
        id: 'DeleteIncompleteMultipartUploads',
        enabled: true,
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7)
      }]
    });


    // IAM Role for EC2 instance
    const instanceRole = new iam.Role(this, 'ValheimInstanceRole', {
      roleName: `${name}-server`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // S3 permissions for instance - explicit permissions without wildcards
    const s3ObjectPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject'
      ],
      resources: [bucket.arnForObjects('*')]
    });
    instanceRole.addToPolicy(s3ObjectPolicy);

    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:GetBucketLocation'
      ],
      resources: [bucket.bucketArn]
    }));

    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeInstances'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`]
    }));

    // Route53 permissions if domain is used
    if (useDomain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: props.domain!
      });

      instanceRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${hostedZone.hostedZoneId}`]
      }));
    }

    // Security Group
    const securityGroup = new ec2.SecurityGroup(this, 'ValheimSecurityGroup', {
      vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true }),
      description: 'Security group for Valheim server',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), "Allow all in");
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(2456, 2458), 'Valheim game ports');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(19999), 'Netdata monitoring');

    // User data script
    const userDataScript = this.readAndTemplateFile('./local/userdata.sh', {
      username,
      bucket: bucket.bucketName
    });

    // Auto Scaling Group
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const useSpot = props.useSpotInstances !== false; // Default to true
    const maxSpotPrice = props.maxSpotPrice || 0.05;
    const volumeSize = props.ebsVolumeSize || 20;

    const launchTemplate = new ec2.LaunchTemplate(this, 'ValheimLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.lookup({
        name: 'ubuntu/images/hvm-ssd/ubuntu-focal-20.*-amd64-server-*',
        owners: ['099720109477']
      }),
      role: instanceRole,
      securityGroup,
      userData: ec2.UserData.custom(userDataScript),
      requireImdsv2: true,
      // spotOptions: {
      //   requestType: ec2.SpotRequestType.ONE_TIME,
      //   maxPrice: maxSpotPrice
      // },
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(volumeSize, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          iops: Math.min(3000, Math.max(volumeSize * 3, 100)), // 3 IOPS per GB, max 3000 for baseline
        })
      }]
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ValheimASG', {
      vpc,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 0,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(10)
      }),
      mixedInstancesPolicy: {
        launchTemplate: launchTemplate,
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.LOWEST_PRICE,
          spotMaxPrice: maxSpotPrice.toString()
        },
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType(props.instanceType) },
          { instanceType: new ec2.InstanceType('t3a.large') }, // Fallback option
          { instanceType: new ec2.InstanceType('t3.medium') }   // Another fallback
        ]
      }
    });

    // Upload scripts to S3
    this.uploadScriptsToS3(bucket, username, props);

    // SNS Topic for notifications
    const topic = new sns.Topic(this, 'ValheimTopic', {
      topicName: `${name}-status`,
      enforceSSL: true
    });

    topic.addSubscription(new snsSubscriptions.EmailSubscription(props.snsEmail));

    // CloudWatch Alarm for auto-shutdown based on network activity
    const shutdownAlarm = new cloudwatch.Alarm(this, 'ValheimStoppedAlarm', {
      alarmName: `${name}-inactivity`,
      alarmDescription: 'Scale down Valheim server after period of inactivity',
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

    // Simple scaling policy triggered by Lambda instead of complex step scaling
    shutdownAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    // EventBridge rule for ASG state changes
    const stateChangeRule = new events.Rule(this, 'ValheimStateChangeRule', {
      ruleName: `${name}-started`,
      description: 'Trigger notifications when Valheim server starts',
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance Launch Successful'],
        detail: {
          'AutoScalingGroupName': [asg.autoScalingGroupName]
        }
      }
    });

    stateChangeRule.addTarget(new targets.SnsTopic(topic, {
      message: events.RuleTargetInput.fromText(
        'At ${time}, Valheim server instance ${detail.EC2InstanceId} has launched in ASG ${detail.AutoScalingGroupName}.'
      )
    }));

    // Lambda for Discord bot
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Create a role for API Gateway to write logs to CloudWatch
    const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
      ]
    });


    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeInstances'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`]
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:SetDesiredCapacity'
      ],
      resources: [asg.autoScalingGroupArn]
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [topic.topicArn]
    }));

    const lambdaFunction = new NodejsFunction(this, 'DiscordBotFunction', {
      entry: '/Users/podium/repos/valheim-on-aws/lambda/index.ts',
      handler: "discordHandler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaRole,
      environment: {
        DISCORD_APP_PUBLIC_KEY: props.discordAppPublicKey,
        ASG_NAME: asg.autoScalingGroupName,
        SNS_TOPIC_ARN: topic.topicArn
      }
    });

    // Allow SNS to trigger Lambda for auto-shutdown
    topic.addSubscription(new snsSubscriptions.LambdaSubscription(lambdaFunction));

    // API Gateway
    // Enable API Gateway to push logs to CloudWatch
    const apiGatewayAccountSettings = new CfnAccount(this, 'ApiGatewayAccountSettings', {
      cloudWatchRoleArn: apiGatewayLoggingRole.roleArn
    });
    
    const logGroup = new logs.LogGroup(this, 'ValheimApiLogs', {
      logGroupName: `/aws/apigateway/${name}-api`,
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
          requestBody: '$input.body'
        })
      }
    });
    
    // Ensure the stage is created after the account settings
    stage.addDependency(apiGatewayAccountSettings);

    const integration = new apigateway.CfnIntegration(this, 'LambdaIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: lambdaFunction.functionArn,
      payloadFormatVersion: '2.0'
    });

    const route = new apigateway.CfnRoute(this, 'DiscordRoute', {
      apiId: httpApi.ref,
      routeKey: 'POST /discord',
      target: `integrations/${integration.ref}`
    });

    new lambda.CfnPermission(this, 'ApiGatewayInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: lambdaFunction.functionName,
      principal: 'apigateway.amazonaws.com',
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.ref}/*/*`
    });

    // Route53 record if domain is provided
    if (useDomain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: props.domain!
      });

      // Note: CNAME will be updated by the instance via user data script
    }

    // Outputs
    new cdk.CfnOutput(this, 'BucketId', {
      value: bucket.bucketName,
      description: 'The S3 bucket name'
    });

    new cdk.CfnOutput(this, 'AutoScalingGroupName', {
      value: asg.autoScalingGroupName,
      description: 'The Auto Scaling Group name'
    });

    new cdk.CfnOutput(this, 'MonitoringUrl', {
      value: useDomain ? `http://${name}.${props.domain}:19999` : 'Check instance public DNS after launch',
      description: 'URL to monitor the Valheim Server'
    });

    new cdk.CfnOutput(this, 'ValheimServerName', {
      value: props.serverName,
      description: 'Name of the Valheim server'
    });
    
    new cdk.CfnOutput(this, 'ApiLogsGroup', {
      value: `/aws/apigateway/${name}-api`,
      description: 'CloudWatch Log Group for API Gateway access logs'
    });


    // Apply tags
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });


    // Suppress AWS managed policy usage - SSM Core is required for remote access
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/ValheimInstanceRole/Resource', [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonSSMManagedInstanceCore is required for Systems Manager access to EC2 instances',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore']
      }
    ]);

    // Suppress S3 server access logging - overkill for this gaming solution
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/ValheimBucket/Resource', [
      {
        id: 'AwsSolutions-S1',
        reason: 'Server access logs are overkill for a gaming server backup bucket'
      }
    ]);
    NagSuppressions.addResourceSuppressions(securityGroup, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'Allow ingress from anywhere on all ports while connectivity issues persist'
      }

    ]);
    NagSuppressions.addResourceSuppressions(asg, [{
      id: 'AwsSolutions-AS3',
      reason: 'Dont need to notify on all scaling events until solution working'
    }, {
      id: 'AwsSolutions-EC26',
      reason: 'Dont care about EBS encryption...yet'
    }])
    // Suppress AWS managed policy usage - Lambda basic execution role is standard
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/LambdaRole/Resource', [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda execution',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      }
    ]);
    
    // Suppress API Gateway logging role managed policy warning
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/ApiGatewayLoggingRole/Resource', [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonAPIGatewayPushToCloudWatchLogs is required for API Gateway to write logs to CloudWatch',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs']
      }
    ]);
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource', [
      {
        id: 'AwsSolutions-L1',
        reason: 'Latest runtime is used!'
      }
    ])
    NagSuppressions.addResourceSuppressions([lambdaFunction], [{
      id: "AwsSolutions-L1",
      reason: "Latest runtime is used!"
    }]);
    NagSuppressions.addResourceSuppressions(route, [{
      id: "AwsSolutions-APIG4",
      reason: "This route does not require authorization until the game server is working"
    }]);
    
    // Suppress log group encryption warning if needed
    NagSuppressions.addResourceSuppressions(logGroup, [{
      id: "AwsSolutions-L1",
      reason: "Log group encryption is not required for this development API"
    }])
    // Suppress necessary wildcards with justification
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/ValheimInstanceRole/DefaultPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 object operations require wildcard as backup file names are dynamic',
        appliesTo: ['Resource::<ValheimBucket59ACF217.Arn>/*']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'EC2 DescribeInstances requires wildcard for instance resources as instance IDs are dynamic',
        appliesTo: ['Resource::arn:aws:ec2:eu-west-2:557690593857:instance/*']
      }
    ]);

    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/LambdaRole/DefaultPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'EC2 DescribeInstances requires wildcard for instance resources as instance IDs are dynamic',
        appliesTo: ['Resource::arn:aws:ec2:eu-west-2:557690593857:instance/*']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Auto Scaling Group ARN contains wildcard UUID that is generated at deployment time',
        appliesTo: ['Resource::arn:aws:autoscaling:eu-west-2:557690593857:autoScalingGroup:*:autoScalingGroupName/<ValheimASG768633DF>']
      }
    ]);

  }

  private readAndTemplateFile(filePath: string, variables: Record<string, string>): string {
    const fullPath = path.join(__dirname, filePath);
    let content = fs.readFileSync(fullPath, 'utf8');

    Object.entries(variables).forEach(([key, value]) => {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    });

    return content;
  }

  private uploadScriptsToS3(bucket: s3.Bucket, username: string, props: ValheimStackProps) {
    const useDomain = props.domain && props.domain !== '';
    const sources = [
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployValheimInstallScript',
        {
          source: './lib/local/install_valheim.sh',
          destinationBucket: bucket,
          destinationKey: 'install_valheim.sh',
          substitutions: { username }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployBootstrapScript',
        {
          source: './lib/local/bootstrap_valheim.sh',
          destinationBucket: bucket,
          destinationKey: 'bootstrap_valheim.sh',
          substitutions: { username, bucket: bucket.bucketName }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployStartScript',
        {
          source: './lib/local/start_valheim.sh',
          destinationBucket: bucket,
          destinationKey: 'start_valheim.sh',
          substitutions: {
            username,
            bucket: bucket.bucketName,
            use_domain: props.domain || '',
            world_name: props.worldName,
            server_name: props.serverName,
            server_password: props.serverPassword
          }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployBackupScript',
        {
          source: './lib/local/backup_valheim.sh',
          destinationBucket: bucket,
          destinationKey: 'backup_valheim.sh',
          substitutions: { username, bucket: bucket.bucketName, world_name: props.worldName }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployCrontab',
        {
          source: './lib/local/crontab',
          destinationBucket: bucket,
          destinationKey: 'crontab',
          substitutions: { username }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployValheimService',
        {
          source: './lib/local/valheim.service',
          destinationBucket: bucket,
          destinationKey: 'valheim.service',
          substitutions: { username }
        }),
      new s3deploy.DeployTimeSubstitutedFile(
        this,
        'DeployAdminList',
        {
          source: './lib/local/adminlist.txt',
          destinationBucket: bucket,
          destinationKey: 'adminlist.txt',
          substitutions: { admins: Object.values(props.admins).filter(Boolean).join('\n') }
        })
    ];

    // Add domain-related scripts if domain is configured
    if (useDomain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZoneForScripts', {
        domainName: props.domain!
      });

      sources.push(
        new s3deploy.DeployTimeSubstitutedFile(
          this,
          'DeployUpdateCnameScript',
          {
            source: './local/update_cname.sh',
            destinationBucket: bucket,
            destinationKey: 'update_cname.sh',
            substitutions: {
              username,
              bucket: bucket.bucketName,
              aws_region: props.awsRegion,
              zone_id: hostedZone.hostedZoneId
            }
          }),
        new s3deploy.DeployTimeSubstitutedFile(
          this,
          'DeployUpdateCnameJson',
          {
            source: './local/update_cname.json',
            destinationBucket: bucket,
            destinationKey: 'update_cname.json',
            substitutions: { fqdn: `valheim.${props.domain}` }
          })
      );
    }

    // Suppress AWS managed policy for bucket deployment Lambda
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource', [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CDK bucket deployment Lambda',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      }
    ]);

    // Suppress S3 wildcards for bucket deployment - required for CDK internal operations
    NagSuppressions.addResourceSuppressionsByPath(this, '/ValheimStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 bucket deployment requires wildcard permissions for CDK internal operations',
        appliesTo: [
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
          'Resource::arn:aws:s3:::cdk-hnb659fds-assets-557690593857-eu-west-2/*',
          'Resource::<ValheimBucket59ACF217.Arn>/*'
        ]
      }
    ]);
  }
}