import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { GameServerConstruct } from './constructs/game-server-construct';
import { GameServerControlConstruct } from './constructs/game-server-control';
import { GameServerObservationConstruct } from './constructs/game-server-observability';

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
  // Cost optimization options
  maxSpotPrice?: number; // Maximum spot price per hour
  useSpotInstances?: boolean; // Enable/disable spot instances
  ebsVolumeSize?: number; // EBS volume size in GB
}

export class ValheimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ValheimStackProps) {
    super(scope, id, props);

    // Retrieve Discord secrets from Parameter Store
    const discordAppPublicKey = ssm.StringParameter.valueFromLookup(
      this, '/valheim/discord/app-public-key'
    );
    const discordAppId = ssm.StringParameter.valueFromLookup(
      this, '/valheim/discord/app-id'
    );
    const discordToken = ssm.StringParameter.valueFromLookup(
      this, '/valheim/discord/token'
    );

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

    const gameServer = new GameServerConstruct(this, "ValheimGameServer", {
      assetBucket: bucket,
      ebsVolumeSize: props.ebsVolumeSize,
      instanceType: props.instanceType,
      maxSpotPrice: props.maxSpotPrice,
      name,
      useDomain: false,
      username,
      domain: `${props.domain}`
    });

    // Upload scripts to S3
    this.uploadScriptsToS3(bucket, username, gameServer.serverLaunchArgsParam.parameterName, props);

    const serverObservation = new GameServerObservationConstruct(this, "ValheimServerObservation", {
      autoScalingGroupName: gameServer.autoScalingGroup.autoScalingGroupName,
      discordToken: `${discordToken}`
    });

    new GameServerControlConstruct(this, "ValheimServerControl", {
      gameServerControl: {
        name: gameServer.autoScalingGroup.autoScalingGroupName,
        arn: gameServer.autoScalingGroup.autoScalingGroupArn
      },
      launchArgsParameter: gameServer.serverLaunchArgsParam,
      discordMessageIdParameter: serverObservation.discordMessageIdParam,
      discordAppId,
      discordAppPublicKey,
      discordToken
    });

    // Apply tags
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

  }

  private uploadScriptsToS3(bucket: s3.Bucket, username: string, argsParam: string, props: ValheimStackProps) {
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
            argsParam,
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
        }),

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