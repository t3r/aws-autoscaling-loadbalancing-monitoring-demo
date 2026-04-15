import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

/** One regional ALB endpoint behind the same Route53 weighted record name. */
export interface RegionalAlbEndpoint {
  /** Unique `SetIdentifier` for this weighted record (e.g. `eu-west-1`). */
  readonly id: string;
  readonly weight: number;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
}

export interface GlobalDnsStackProps extends cdk.StackProps {
  /** Existing public hosted zone ID (starts with `Z`). */
  readonly hostedZoneId: string;
  /** Hosted zone name (e.g. `example.com`). */
  readonly hostedZoneName: string;
  /**
   * Relative record name under the zone (e.g. `demo` → `demo.example.com`).
   * Use `@` for zone apex if your zone configuration expects it.
   */
  readonly recordName: string;
  /** Regional ALBs to balance; Route53 omits unhealthy records when health checks fail. */
  readonly regionalLoadBalancers: RegionalAlbEndpoint[];
}

/**
 * Weighted Route53 alias records to regional ALBs, each with an HTTP health check on `/`.
 * Deploy this stack in one region (often the same as your primary app region); enable
 * `crossRegionReferences` on this stack and on every regional stack that owns an ALB.
 */
export class GlobalDnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GlobalDnsStackProps) {
    super(scope, id, props);

    if (props.regionalLoadBalancers.length === 0) {
      throw new Error('GlobalDnsStack requires at least one regionalLoadBalancers entry');
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    const healthCheckPeriod = cdk.Duration.minutes(1);
    const healthCheckRows: { id: string; healthCheck: route53.HealthCheck }[] = [];

    for (const ep of props.regionalLoadBalancers) {
      const healthCheck = new route53.HealthCheck(this, `AlbHealthCheck${ep.id}`, {
        type: route53.HealthCheckType.HTTP,
        fqdn: ep.loadBalancer.loadBalancerDnsName,
        port: 80,
        resourcePath: '/',
      });
      healthCheckRows.push({ id: ep.id, healthCheck });

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

    // Route 53 health check metrics are emitted to CloudWatch in us-east-1 only.
    const route53MetricRegion = 'us-east-1';

    const healthCheckStatusMetrics = healthCheckRows.map(({ id, healthCheck }) =>
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

    const healthCheckPercentageMetrics = healthCheckRows.map(({ id, healthCheck }) =>
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

    const route53DashboardName = `${this.stackName}-route53-health`;
    new cloudwatch.Dashboard(this, 'Route53HealthDashboard', {
      dashboardName: route53DashboardName,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Route 53 health checks — status (minimum across regions; 1 = healthy, 0 = unhealthy)',
            left: healthCheckStatusMetrics,
            width: 24,
            height: 6,
            leftYAxis: { min: 0, max: 1.05 },
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Route 53 health checks — estimated % healthy (Route 53 metric)',
            left: healthCheckPercentageMetrics,
            width: 24,
            height: 6,
            leftYAxis: { min: 0, max: 100 },
          }),
        ],
      ],
    });

    const fqdn =
      props.recordName === '@' || props.recordName === ''
        ? props.hostedZoneName
        : `${props.recordName}.${props.hostedZoneName}`;

    new cdk.CfnOutput(this, 'WeightedDnsRecordFqdn', {
      value: fqdn,
      description: 'FQDN for weighted HTTP alias records (healthy regions only)',
    });

    new cdk.CfnOutput(this, 'Route53HealthDashboardName', {
      value: route53DashboardName,
      description: 'CloudWatch dashboard for Route 53 endpoint health checks',
    });
  }
}
