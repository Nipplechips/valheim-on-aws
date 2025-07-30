#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ValheimStack, ValheimStackProps } from '../lib/valheim-stack';

const app = new cdk.App();

const config: ValheimStackProps = {
  admins: { "finch": "76561198082848016" },
  awsRegion: "eu-west-2",
  awsAccountId: "557690593857",
  domain: "",
  instanceType: "t3a.medium",
  pgpKey: "keybase:finch",
  purpose: "prod",
  s3LifecycleExpiration: "90",
  serverName: "valheimuniverse",
  serverPassword: "hello123",
  snsEmail: "david.finch.bournemouth@gmail.com",
  uniqueId: "",
  worldName: "aroundtown"
};

new ValheimStack(app, 'ValheimStack', {
  env: {
    account: config.awsAccountId,
    region: config.awsRegion,
  },
  tags: {
    application: "game-server:valheim"
  },
  maxSpotPrice: 0.05,
  useSpotInstances: true,
  ebsVolumeSize: 20,
  ...config
});

//cdk.Aspects.of(app).add(new AwsSolutionsChecks({verbose: true}));