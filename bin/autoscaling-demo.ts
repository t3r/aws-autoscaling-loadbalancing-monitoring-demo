#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AutoscalingDemoStack } from '../lib/autoscaling-demo-stack';
import { GlobalDnsStack } from '../lib/global-dns-stack';

const app = new cdk.App();

const multiRegionCtx = app.node.tryGetContext('multiRegion');
const useMultiRegion =
  multiRegionCtx === true || multiRegionCtx === 'true' || multiRegionCtx === '1';

if (!useMultiRegion) {
  new AutoscalingDemoStack(app, 'AutoscalingDemoStack', {
    /* If you don't specify 'env', this stack will be environment-agnostic.
     * Account/Region-dependent features and context lookups will not work,
     * but a single synthesized template can be deployed anywhere. */
    // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
} else {
  const account =
    (app.node.tryGetContext('account') as string | undefined) ?? process.env.CDK_DEFAULT_ACCOUNT;
  const hostedZoneId = app.node.tryGetContext('hostedZoneId') as string | undefined;
  const hostedZoneName = app.node.tryGetContext('hostedZoneName') as string | undefined;

  if (!account) {
    throw new Error(
      'multiRegion=true requires CDK context "account" (12 digits) or CDK_DEFAULT_ACCOUNT in the environment.',
    );
  }
  if (!hostedZoneId || !hostedZoneName) {
    throw new Error(
      'multiRegion=true requires CDK context "hostedZoneId" and "hostedZoneName" for the existing Route53 hosted zone.',
    );
  }

  const primaryRegion = (app.node.tryGetContext('primaryRegion') as string) ?? 'eu-central-1';
  const secondaryRegion = (app.node.tryGetContext('secondaryRegion') as string) ?? 'eu-west-3';
  const dnsStackRegion = (app.node.tryGetContext('dnsStackRegion') as string) ?? primaryRegion;
  const dnsRecordName = (app.node.tryGetContext('dnsRecordName') as string) ?? 'demo';

  const primaryStack = new AutoscalingDemoStack(app, `AutoscalingDemo-${primaryRegion}`, {
    env: { account, region: primaryRegion },
    crossRegionReferences: true,
  });

  const secondaryStack = new AutoscalingDemoStack(app, `AutoscalingDemo-${secondaryRegion}`, {
    env: { account, region: secondaryRegion },
    crossRegionReferences: true,
    enableLocustDriver: false,
  });

  new GlobalDnsStack(app, 'AutoscalingDemoGlobalDns', {
    env: { account, region: dnsStackRegion },
    crossRegionReferences: true,
    hostedZoneId,
    hostedZoneName,
    recordName: dnsRecordName,
    regionalLoadBalancers: [
      { id: `alb-${primaryRegion}`, weight: 50, loadBalancer: primaryStack.webAlb },
      { id: `alb-${secondaryRegion}`, weight: 50, loadBalancer: secondaryStack.webAlb },
    ],
  });
}
