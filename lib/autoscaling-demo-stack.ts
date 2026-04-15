import * as cdk from 'aws-cdk-lib/core';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { ApacheBehindAlb } from './constructs/apache-behind-alb';
import { DemoNetwork } from './constructs/demo-network';
import { HttpScalingObservability } from './constructs/http-scaling-observability';
import { LocustLoadGenerator } from './constructs/locust-load-generator';

export interface AutoscalingDemoStackProps extends cdk.StackProps {
  /**
   * When false, no Locust driver EC2 is provisioned (use in secondary regions of a multi-region deploy).
   * @default true
   */
  readonly enableLocustDriver?: boolean;
}

/**
 * Demo stack: composes small constructs (network → web tier → scaling/observability → optional Locust).
 * Each child maps cleanly to CloudFormation nested resource namespaces.
 */
export class AutoscalingDemoStack extends cdk.Stack {
  /** Regional ALB (for Route53 alias / multi-region DNS). */
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

    const network = new DemoNetwork(this, 'Network');
    const web = new ApacheBehindAlb(this, 'Web', { vpc: network.vpc });
    this.webAlb = web.loadBalancer;

    const scaling = new HttpScalingObservability(this, 'HttpScaling', {
      dashboardNamePrefix: this.stackName,
      autoScalingGroup: web.autoScalingGroup,
      webTargetGroup: web.webTargetGroup,
    });

    if (enableLocustDriver) {
      const locust = new LocustLoadGenerator(this, 'Locust', {
        vpc: network.vpc,
        targetBaseUrl: `http://${web.loadBalancer.loadBalancerDnsName}`,
      });
      locust.instance.node.addDependency(web.loadBalancer);

      new cdk.CfnOutput(this, 'LocustInstancePublicDns', {
        description: 'Locust driver — public DNS (add SG inbound for Locust port to open the web UI)',
        value: locust.instance.instancePublicDnsName,
      });

      new cdk.CfnOutput(this, 'LocustWebPort', {
        description: 'Locust web UI port on the driver instance',
        value: String(locust.webUiPort),
      });
    }

    new cdk.CfnOutput(this, 'LoadBalancerDns', {
      description: 'Open in a browser to reach Apache via the ALB',
      value: web.loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'DashboardName', {
      description: 'CloudWatch dashboard (view in CloudWatch → Dashboards)',
      value: `${this.stackName}-http-asg`,
    });

    new cdk.CfnOutput(this, 'ScalingAlarmsTopicArn', {
      description:
        'SNS topic ARN — subscribe (email/SMS) for notifications when scale-out or scale-in alarms enter ALARM or OK',
      value: scaling.scalingAlarmsTopic.topicArn,
    });
  }
}
