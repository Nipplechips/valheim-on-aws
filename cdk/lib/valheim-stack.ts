import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
import * as fs from 'fs';
import * as path from 'path';

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
        id: 'DeleteOldBackups',
        enabled: true,
        expiration: cdk.Duration.days(parseInt(props.s3LifecycleExpiration))
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

    const launchTemplate = new ec2.LaunchTemplate(this, 'ValheimLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.lookup({
        name: 'ubuntu/images/hvm-ssd/ubuntu-focal-20.*-amd64-server-*',
        owners: ['099720109477']
      }),
      role: instanceRole,
      securityGroup,
      userData: ec2.UserData.custom(userDataScript),
      requireImdsv2: true
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ValheimASG', {
      vpc,
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(10)
      })
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
        period: cdk.Duration.minutes(5)
      }),
      threshold: 50000,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
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

    const lambdaFunction = new lambda.Function(this, 'ValheimControlFunction', {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: 'index.discordHandler',
      code: lambda.Code.fromAsset('../lambda/layer.zip'),
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
    const httpApi = new apigateway.CfnApi(this, 'ValheimApi', {
      name: 'Valheim Server Control API',
      protocolType: 'HTTP'
    });

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
      content = content.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    });

    return content;
  }

  private uploadScriptsToS3(bucket: s3.Bucket, username: string, props: ValheimStackProps) {
    const useDomain = props.domain && props.domain !== '';
    const sources = [
      s3deploy.Source.data('install_valheim.sh', this.readAndTemplateFile('./local/install_valheim.sh', { username })),
      s3deploy.Source.data('bootstrap_valheim.sh', this.readAndTemplateFile('./local/bootstrap_valheim.sh', { username, bucket: bucket.bucketName })),
      s3deploy.Source.data('start_valheim.sh', this.readAndTemplateFile('./local/start_valheim.sh', {
        username,
        bucket: bucket.bucketName,
        use_domain: props.domain || '',
        world_name: props.worldName,
        server_name: props.serverName,
        server_password: props.serverPassword
      })),
      s3deploy.Source.data('backup_valheim.sh', this.readAndTemplateFile('./local/backup_valheim.sh', {
        username,
        bucket: bucket.bucketName,
        world_name: props.worldName
      })),
      s3deploy.Source.data('crontab', this.readAndTemplateFile('./local/crontab', { username })),
      s3deploy.Source.data('valheim.service', this.readAndTemplateFile('./local/valheim.service', { username })),
      s3deploy.Source.data('adminlist.txt', this.readAndTemplateFile('./local/adminlist.txt', { admins: Object.values(props.admins).filter(Boolean).join('\n') }))
    ];

    // Add domain-related scripts if domain is configured
    if (useDomain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZoneForScripts', {
        domainName: props.domain!
      });

      sources.push(
        s3deploy.Source.data('update_cname.sh', this.readAndTemplateFile('./local/update_cname.sh', {
          username,
          bucket: bucket.bucketName,
          aws_region: props.awsRegion,
          zone_id: hostedZone.hostedZoneId
        })),
        s3deploy.Source.data('update_cname.json', this.readAndTemplateFile('./local/update_cname.json', {
          fqdn: `valheim.${props.domain}`
        }))
      );
    }

    new s3deploy.BucketDeployment(this, 'DeployScripts', {
      sources,
      destinationBucket: bucket
    });

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