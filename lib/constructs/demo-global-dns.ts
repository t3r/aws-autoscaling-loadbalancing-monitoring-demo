import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

/** One regional ALB behind the same weighted DNS name. */
export interface RegionalAlbEndpoint {
  readonly id: string;
  readonly weight: number;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
}

export interface DemoGlobalDnsProps {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly recordName: string;
  readonly regionalLoadBalancers: RegionalAlbEndpoint[];
}

/**
 * Weighted Route53 aliases to regional ALBs (HTTP health checks + CloudWatch dashboard in us-east-1 metrics).
 */
export class DemoGlobalDns extends Construct {
  public readonly weightedRecordFqdn: string;
  public readonly healthDashboardName: string;

  constructor(scope: Construct, id: string, props: DemoGlobalDnsProps) {
    super(scope, id);

    if (props.regionalLoadBalancers.length === 0) {
      throw new Error('DemoGlobalDns requires at least one regionalLoadBalancers entry');
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    const healthCheckPeriod = cdk.Duration.minutes(1);
    const rows: { id: string; healthCheck: route53.HealthCheck }[] = [];

    for (const ep of props.regionalLoadBalancers) {
      const healthCheck = new route53.HealthCheck(this, `AlbHealthCheck${ep.id}`, {
        type: route53.HealthCheckType.HTTP,
        fqdn: ep.loadBalancer.loadBalancerDnsName,
        port: 80,
        resourcePath: '/',
      });
      rows.push({ id: ep.id, healthCheck });

      new route53.ARecord(this, `WeightedAlias${ep.id}`, {
        zone,
        recordName: props.recordName,
        target: route53.RecordTarget.fromAlias(
          new route53_targets.LoadBalancerTarget(ep.loadBalancer, { evaluateTargetHealth: true }),
        ),
        weight: ep.weight,
        setIdentifier: ep.id,
        healthCheck,
      });
    }

    const route53MetricRegion = 'us-east-1';
    const statusMetrics = rows.map(({ id, healthCheck }) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Route53',
        metricName: 'HealthCheckStatus',
        dimensionsMap: { HealthCheckId: healthCheck.healthCheckId },
        statistic: cloudwatch.Stats.MINIMUM,
        period: healthCheckPeriod,
        region: route53MetricRegion,
        label: `${id} (1=healthy)`,
      }),
    );
    const pctMetrics = rows.map(({ id, healthCheck }) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Route53',
        metricName: 'HealthCheckPercentageHealthy',
        dimensionsMap: { HealthCheckId: healthCheck.healthCheckId },
        statistic: cloudwatch.Stats.AVERAGE,
        period: healthCheckPeriod,
        region: route53MetricRegion,
        label: `${id} % healthy`,
      }),
    );

    const stackName = cdk.Stack.of(this).stackName;
    this.healthDashboardName = `${stackName}-route53-health`;

    new cloudwatch.Dashboard(this, 'Route53HealthDashboard', {
      dashboardName: this.healthDashboardName,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Route 53 health checks — status (1 = healthy, 0 = unhealthy)',
            left: statusMetrics,
            width: 24,
            height: 6,
            leftYAxis: { min: 0, max: 1.05 },
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Route 53 health checks — % of checkers reporting healthy',
            left: pctMetrics,
            width: 24,
            height: 6,
            leftYAxis: { min: 0, max: 100 },
          }),
        ],
      ],
    });

    this.weightedRecordFqdn =
      props.recordName === '@' || props.recordName === ''
        ? props.hostedZoneName
        : `${props.recordName}.${props.hostedZoneName}`;
  }
}
