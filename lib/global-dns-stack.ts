import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { DemoGlobalDns, RegionalAlbEndpoint } from './constructs/demo-global-dns';

export type { RegionalAlbEndpoint };

export interface GlobalDnsStackProps extends cdk.StackProps {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly recordName: string;
  readonly regionalLoadBalancers: RegionalAlbEndpoint[];
}

/**
 * Thin stack: delegates weighted records + health dashboards to {@link DemoGlobalDns}.
 */
export class GlobalDnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GlobalDnsStackProps) {
    super(scope, id, props);

    const dns = new DemoGlobalDns(this, 'Dns', {
      hostedZoneId: props.hostedZoneId,
      hostedZoneName: props.hostedZoneName,
      recordName: props.recordName,
      regionalLoadBalancers: props.regionalLoadBalancers,
    });

    new cdk.CfnOutput(this, 'WeightedDnsRecordFqdn', {
      value: dns.weightedRecordFqdn,
      description: 'FQDN for weighted HTTP alias records (healthy regions only)',
    });

    new cdk.CfnOutput(this, 'Route53HealthDashboardName', {
      value: dns.healthDashboardName,
      description: 'CloudWatch dashboard for Route 53 endpoint health checks',
    });
  }
}
