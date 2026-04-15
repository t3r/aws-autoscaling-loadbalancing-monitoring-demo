import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface HttpScalingObservabilityProps {
  /** Used for the CloudWatch dashboard name suffix. */
  readonly dashboardNamePrefix: string;
  readonly autoScalingGroup: autoscaling.IAutoScalingGroup;
  readonly webTargetGroup: elbv2.ApplicationTargetGroup;
  readonly loadMetricPeriodMinutes?: number;
}

/**
 * Step scaling on HTTP load (from ALB RequestCountPerTarget), CloudWatch dashboard, and SNS on alarm transitions.
 */
export class HttpScalingObservability extends Construct {
  public readonly scalingAlarmsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: HttpScalingObservabilityProps) {
    super(scope, id);

    const { autoScalingGroup: asg, webTargetGroup, dashboardNamePrefix } = props;
    const loadMetricPeriod = cdk.Duration.minutes(props.loadMetricPeriodMinutes ?? 1);

    const requestCountPerTarget = webTargetGroup.metrics.requestCountPerTarget({
      statistic: cloudwatch.Stats.SUM,
      period: loadMetricPeriod,
    });

    const httpRequestsPerSecondPerInstance = new cloudwatch.MathExpression({
      expression: 'perTarget / PERIOD(perTarget)',
      usingMetrics: { perTarget: requestCountPerTarget },
      label: 'HTTP requests/s per instance (ALB avg per target)',
      period: loadMetricPeriod,
    });

    const asgPeriod = cdk.Duration.minutes(1);
    const asgDim = { AutoScalingGroupName: asg.autoScalingGroupName };

    const groupDesiredCapacity = asgMetric('GroupDesiredCapacity', asgDim, asgPeriod);
    const groupInServiceInstances = asgMetric('GroupInServiceInstances', asgDim, asgPeriod);
    const groupPendingInstances = asgMetric('GroupPendingInstances', asgDim, asgPeriod);
    const groupTerminatingInstances = asgMetric('GroupTerminatingInstances', asgDim, asgPeriod);

    new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${dashboardNamePrefix}-http-asg`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'HTTP requests/s per instance (from ALB RequestCountPerTarget)',
            left: [httpRequestsPerSecondPerInstance],
            width: 24,
            height: 6,
            leftAnnotations: [
              { value: 10, label: 'Scale in (≤10)', color: cloudwatch.Color.GREEN },
              { value: 50, label: 'Scale out (≥50)', color: cloudwatch.Color.RED },
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Auto Scaling activity (desired vs in-service, pending, terminating)',
            left: [
              groupDesiredCapacity.with({ label: 'Desired capacity', color: cloudwatch.Color.BLUE }),
              groupInServiceInstances.with({ label: 'In service', color: cloudwatch.Color.GREEN }),
              groupPendingInstances.with({ label: 'Pending', color: cloudwatch.Color.ORANGE }),
              groupTerminatingInstances.with({ label: 'Terminating', color: cloudwatch.Color.RED }),
            ],
            width: 24,
            height: 6,
          }),
        ],
      ],
    });

    const scaleOutPolicy = new autoscaling.CfnScalingPolicy(this, 'HttpScaleOutPolicy', {
      autoScalingGroupName: asg.autoScalingGroupName,
      policyType: 'StepScaling',
      adjustmentType: 'ChangeInCapacity',
      metricAggregationType: 'Average',
      estimatedInstanceWarmup: 120,
      stepAdjustments: [{ metricIntervalLowerBound: 0, scalingAdjustment: 3 }],
    });

    const scaleInPolicy = new autoscaling.CfnScalingPolicy(this, 'HttpScaleInPolicy', {
      autoScalingGroupName: asg.autoScalingGroupName,
      policyType: 'StepScaling',
      adjustmentType: 'ChangeInCapacity',
      metricAggregationType: 'Average',
      estimatedInstanceWarmup: 120,
      stepAdjustments: [{ metricIntervalUpperBound: 0, scalingAdjustment: -1 }],
    });

    this.scalingAlarmsTopic = new sns.Topic(this, 'HttpScalingAlarmsTopic', {
      displayName: 'HTTP scaling alarms (scale out / scale in)',
    });
    this.scalingAlarmsTopic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));

    const scaleOutAlarm = new cloudwatch.Alarm(this, 'HttpScaleOutAlarm', {
      alarmDescription: 'Scale out when HTTP req/s per instance is at or above 50',
      metric: httpRequestsPerSecondPerInstance,
      threshold: 50,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    scaleOutAlarm.addAlarmAction({
      bind: (_scope, _alarm) => ({ alarmActionArn: scaleOutPolicy.attrArn }),
    });
    scaleOutAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.scalingAlarmsTopic));
    scaleOutAlarm.addOkAction(new cloudwatch_actions.SnsAction(this.scalingAlarmsTopic));

    const scaleInAlarm = new cloudwatch.Alarm(this, 'HttpScaleInAlarm', {
      alarmDescription: 'Scale in when HTTP req/s per instance is at or below 10',
      metric: httpRequestsPerSecondPerInstance,
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    scaleInAlarm.addAlarmAction({
      bind: (_scope, _alarm) => ({ alarmActionArn: scaleInPolicy.attrArn }),
    });
    scaleInAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.scalingAlarmsTopic));
    scaleInAlarm.addOkAction(new cloudwatch_actions.SnsAction(this.scalingAlarmsTopic));
  }
}

function asgMetric(
  metricName: string,
  dimensionsMap: Record<string, string>,
  period: cdk.Duration,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'AWS/AutoScaling',
    metricName,
    dimensionsMap,
    statistic: cloudwatch.Stats.AVERAGE,
    period,
  });
}
