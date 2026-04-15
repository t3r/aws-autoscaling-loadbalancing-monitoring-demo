import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface AutoscalingDemoStackProps extends cdk.StackProps {
  /**
   * When false, no Locust driver EC2 is provisioned (use in secondary regions of a multi-region deploy).
   * @default true
   */
  readonly enableLocustDriver?: boolean;
}

export class AutoscalingDemoStack extends cdk.Stack {
  /** Regional ALB fronting the Auto Scaling group (for Route53 alias / multi-region DNS). */
  public readonly webAlb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props?: AutoscalingDemoStackProps) {
    const trainingTags: Record<string, string> = {
      't3r:training': 'lobster',
      't3r:purpose': 'training',
      't3r:remove-after': '2026-04-20',
    };
    super(scope, id, {
      ...props,
      tags: { ...trainingTags, ...props?.tags },
    });

    const enableLocustDriver = props?.enableLocustDriver !== false;

    for (const [key, value] of Object.entries(trainingTags)) {
      cdk.Tags.of(this).add(key, value, { applyToLaunchedInstances: true });
    }

    // Public subnets only, no NAT gateways
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false,
        },
      ],
    });

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'HTTP from ALB only',
      allowAllOutbound: true,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'dnf -y update',
      'dnf -y install httpd',
      'IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" http://169.254.169.254/latest/meta-data/instance-id)',
      'PRIVATE_DNS=$(curl -fsS -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" http://169.254.169.254/latest/meta-data/local-hostname)',
      '{',
      "  echo '<!DOCTYPE html>'",
      "  echo '<html lang=\"en\">'",
      "  echo '<head><meta charset=\"utf-8\"/><title>Instance</title></head>'",
      "  echo '<body>'",
      "  echo '<h1>Instance metadata</h1>'",
      '  echo "<p><strong>Instance ID:</strong> ${INSTANCE_ID}</p>"',
      '  echo "<p><strong>Private DNS name:</strong> ${PRIVATE_DNS}</p>"',
      "  echo '</body></html>'",
      '} > /var/www/html/index.html',
      'systemctl enable httpd',
      'systemctl start httpd',
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
      securityGroup: instanceSecurityGroup,
      role: instanceRole,
      associatePublicIpAddress: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 2,
      // desiredCapacity: 2,
      maxCapacity: 10,
      cooldown: cdk.Duration.minutes(2),
      groupMetrics: [autoscaling.GroupMetrics.all()],
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        gracePeriod: cdk.Duration.minutes(5),
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
      }),
    });

    this.webAlb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const alb = this.webAlb;

    instanceSecurityGroup.connections.allowFrom(
      alb,
      ec2.Port.tcp(80),
      'HTTP from load balancer',
    );

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    const webTargetGroup = listener.addTargets('Web', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });

    const loadMetricPeriod = cdk.Duration.minutes(1);
    const requestCountPerTarget = webTargetGroup.metrics.requestCountPerTarget({
      statistic: cloudwatch.Stats.SUM,
      period: loadMetricPeriod,
    });

    // ALB RequestCountPerTarget (Sum) is total requests in the period divided by healthy target count — i.e. load per instance.
    // Divide by period seconds to express as HTTP requests per second per instance (average across targets).
    const httpRequestsPerSecondPerInstance = new cloudwatch.MathExpression({
      expression: 'perTarget / PERIOD(perTarget)',
      usingMetrics: { perTarget: requestCountPerTarget },
      label: 'HTTP requests/s per instance (ALB avg per target)',
      period: loadMetricPeriod,
    });

    const asgPeriod = cdk.Duration.minutes(1);
    const asgDim = { AutoScalingGroupName: asg.autoScalingGroupName };

    const groupInServiceInstances = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupInServiceInstances',
      dimensionsMap: asgDim,
      statistic: cloudwatch.Stats.AVERAGE,
      period: asgPeriod,
    });

    const groupDesiredCapacity = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupDesiredCapacity',
      dimensionsMap: asgDim,
      statistic: cloudwatch.Stats.AVERAGE,
      period: asgPeriod,
    });

    const groupPendingInstances = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupPendingInstances',
      dimensionsMap: asgDim,
      statistic: cloudwatch.Stats.AVERAGE,
      period: asgPeriod,
    });

    const groupTerminatingInstances = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupTerminatingInstances',
      dimensionsMap: asgDim,
      statistic: cloudwatch.Stats.AVERAGE,
      period: asgPeriod,
    });

    new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${this.stackName}-http-asg`,
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

    const scalingAlarmsTopic = new sns.Topic(this, 'HttpScalingAlarmsTopic', {
      displayName: 'HTTP scaling alarms (scale out / scale in)',
    });
    scalingAlarmsTopic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));

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
    scaleOutAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(scalingAlarmsTopic));
    scaleOutAlarm.addOkAction(new cloudwatch_actions.SnsAction(scalingAlarmsTopic));

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
    scaleInAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(scalingAlarmsTopic));
    scaleInAlarm.addOkAction(new cloudwatch_actions.SnsAction(scalingAlarmsTopic));

    const locustWebPort = 8089;

    if (enableLocustDriver) {
      const locustDriverSecurityGroup = new ec2.SecurityGroup(this, 'LocustDriverSecurityGroup', {
        vpc,
        description: 'Locust driver',
        allowAllOutbound: true,
      });

      const locustDriverRole = new iam.Role(this, 'LocustDriverRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ],
      });

      const locustPy = `from locust import HttpUser, task, between


class AlbDemoUser(HttpUser):
    wait_time = between(0.01, 0.05)

    @task
    def get_index(self) -> None:
        self.client.get("/", name="GET /")
`;

      const locustSystemdUnit = `[Unit]
Description=Locust load generator (web UI + workers on this host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/locust/locust.env
ExecStart=/bin/bash -lc 'set -a; source /opt/locust/locust.env; set +a; exec /opt/locust/venv/bin/python -m locust -f /opt/locust/locustfile.py --host "$LOCUST_TARGET" --web-host 0.0.0.0 --web-port ${locustWebPort}'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

      const locustUserData = ec2.UserData.forLinux();
      locustUserData.addCommands(
        'set -euxo pipefail',
        // Isolated venv avoids pip trying to uninstall RPM-owned setuptools on the system interpreter.
        // Locust pulls gevent etc.; wheels may fall back to source builds without a C toolchain.
        'dnf -y install python3 python3-pip gcc make python3-devel openssl-devel',
        'mkdir -p /opt/locust',
        'python3 -m venv /opt/locust/venv',
        '/opt/locust/venv/bin/pip install --upgrade pip',
        '/opt/locust/venv/bin/pip install "locust>=2.24,<3"',
        `echo "LOCUST_TARGET=http://${alb.loadBalancerDnsName}" > /opt/locust/locust.env`,
        `echo '${Buffer.from(locustPy, 'utf-8').toString('base64')}' | base64 -d > /opt/locust/locustfile.py`,
        `echo '${Buffer.from(locustSystemdUnit, 'utf-8').toString('base64')}' | base64 -d > /etc/systemd/system/locust.service`,
        'chmod 644 /etc/systemd/system/locust.service',
        'systemctl daemon-reload',
        'systemctl enable locust.service',
        'systemctl start locust.service',
      );

      // m5.large: ENA networking, up to 10 Gbps — plenty of headroom for ~1000 HTTP R/s with small payloads.
      const locustDriver = new ec2.Instance(this, 'LocustDriver', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
        machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        securityGroup: locustDriverSecurityGroup,
        role: locustDriverRole,
        associatePublicIpAddress: true,
        userData: locustUserData,
        requireImdsv2: true,
      });
      locustDriver.node.addDependency(alb);

      new cdk.CfnOutput(this, 'LocustInstancePublicDns', {
        description: 'Locust driver — public DNS (add SG inbound for Locust port to open the web UI)',
        value: locustDriver.instancePublicDnsName,
      });

      new cdk.CfnOutput(this, 'LocustWebPort', {
        description: 'Locust web UI port on the driver instance',
        value: String(locustWebPort),
      });
    }

    new cdk.CfnOutput(this, 'LoadBalancerDns', {
      description: 'Open in a browser to reach Apache via the ALB',
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'DashboardName', {
      description: 'CloudWatch dashboard (view in CloudWatch → Dashboards)',
      value: `${this.stackName}-http-asg`,
    });

    new cdk.CfnOutput(this, 'ScalingAlarmsTopicArn', {
      description:
        'SNS topic ARN — subscribe (email/SMS) for notifications when scale-out or scale-in alarms enter ALARM or OK',
      value: scalingAlarmsTopic.topicArn,
    });
  }
}
