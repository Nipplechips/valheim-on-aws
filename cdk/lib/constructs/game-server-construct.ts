import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from "constructs";
import { readAndTemplateFile } from '../util';
import { NagSuppressions } from 'cdk-nag/lib/nag-suppressions';

export interface GameServerConstructProps {
    name: string;
    username: string;
    assetBucket: s3.Bucket;
    useDomain: boolean;
    domain?: string;
    maxSpotPrice?: number;
    ebsVolumeSize?: number;
    instanceType: string;
}
export class GameServerConstruct extends Construct {
    public autoScalingGroup: autoscaling.AutoScalingGroup;
    public serverLaunchArgsParam: ssm.StringParameter;

    constructor(scope: Construct, id: string, props: GameServerConstructProps) {
        super(scope, id);

        // Parameter for runtime launch argument substitution
        this.serverLaunchArgsParam = new ssm.StringParameter(this, 'AdditionalLaunchOptionsParameter', {
            description: 'Valheim launch options used as server args',
            stringValue: ' ',
            tier: ssm.ParameterTier.STANDARD,
        });

        // IAM Role for EC2 instance
        const instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `${props.name}-server`,
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
            resources: [props.assetBucket.arnForObjects('*')]
        });

        instanceRole.addToPolicy(s3ObjectPolicy);
        instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:ListBucket',
                's3:GetBucketLocation'
            ],
            resources: [props.assetBucket.bucketArn]
        }));
        instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'events:*'
            ],
            resources: ["*"]
        }));
        instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: [`arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`]
        }));

        instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [`${this.serverLaunchArgsParam.parameterArn}`]
        }));

        // Route53 permissions if domain is used
        if (props.useDomain) {
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
        const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true }),
            description: 'Security group for Game server',
            allowAllOutbound: true,
        });

        //securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), "Allow all in");
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(2456, 2458), 'Game ports');
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(19999), 'Netdata monitoring');

        // User data script
        const userDataScript = readAndTemplateFile('./local/userdata.sh', {
            username: props.username,
            bucket: props.assetBucket.bucketName
        });

        // Auto Scaling Group
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

        const useSpot = true; // Default to true
        const maxSpotPrice = props.maxSpotPrice || 0.05;
        const volumeSize = props.ebsVolumeSize || 20;

        const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
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

        this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ASG', {
            vpc,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 0,
            healthChecks: autoscaling.HealthChecks.ec2({
                gracePeriod: cdk.Duration.minutes(10)
            }),
            notifications: [],
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



        // NagSuppressions.addResourceSuppressions(securityGroup, [
        //     {
        //         id: 'AwsSolutions-EC23',
        //         reason: 'Allow ingress from anywhere on all ports while connectivity issues persist'
        //     }
        // ]);

        NagSuppressions.addResourceSuppressions(this.autoScalingGroup, [{
            id: 'AwsSolutions-AS3',
            reason: 'Dont need to notify on all scaling events until solution working'
        }, {
            id: 'AwsSolutions-EC26',
            reason: 'Dont care about EBS encryption...yet'
        }]);

        NagSuppressions.addResourceSuppressions(instanceRole, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'I cannot be bothered to craft a custom when AmazonSSMManagedInstanceCore exists',
                appliesTo: [
                    `Policy::arn:${cdk.Stack.of(this).account}:iam::aws:policy/service-role/AmazonEC2RoleforSSM`,
                    `Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore`,
                    'Action::s3:*'
                ]
            }
        ]);
        NagSuppressions.addResourceSuppressionsByPath(cdk.Stack.of(this), "/ValheimStack/ValheimGameServer/InstanceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'We dont know the instance ids at runtime, need to use wildcards',
                appliesTo: [
                    'Action::s3:*',
                    `Resource::${props.assetBucket.bucketArn}`,
                    `Resource::arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`
                ]
            }
        ]);
    }
}