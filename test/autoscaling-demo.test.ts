import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AutoscalingDemoStack } from '../lib/autoscaling-demo-stack';
import { AUTOSCALING_DEMO_TRAINING_TAGS } from '../lib/training-tags';

type CfnTag = { Key: string; Value: string };
type CfnAsgTag = CfnTag & { PropagateAtLaunch: boolean };

function firstResourceProperties(
  template: Template,
  resourceType: string,
): Record<string, unknown> | undefined {
  const resources = template.toJSON().Resources as Record<
    string,
    { Type?: string; Properties?: Record<string, unknown> }
  >;
  const resource = Object.values(resources).find((r) => r.Type === resourceType);
  return resource?.Properties;
}

function expectDefaultTrainingTagsOnResource(tags: CfnTag[] | undefined): void {
  expect(tags).toBeDefined();
  for (const [key, value] of Object.entries(AUTOSCALING_DEMO_TRAINING_TAGS)) {
    expect(tags!).toContainEqual({ Key: key, Value: value });
  }
}

function expectDefaultTrainingTagsPropagatedOnAsg(tags: CfnAsgTag[] | undefined): void {
  expect(tags).toBeDefined();
  for (const [key, value] of Object.entries(AUTOSCALING_DEMO_TRAINING_TAGS)) {
    expect(tags!).toContainEqual({ Key: key, Value: value, PropagateAtLaunch: true });
  }
}

describe('AutoscalingDemoStack', () => {
  let app: cdk.App;
  let stack: AutoscalingDemoStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new AutoscalingDemoStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  describe('network (DemoNetwork)', () => {
    test('provisions a single VPC with DNS and no NAT gateways', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });

    test('uses two public subnets across AZs (no public IP on subnet launch map)', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 2);
      template.hasResourceProperties('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: false,
        Tags: Match.arrayWith([{ Key: 'aws-cdk:subnet-type', Value: 'Public' }]),
      });
    });

    test('applies AutoscalingDemoStack default training tags to the VPC', () => {
      const props = firstResourceProperties(template, 'AWS::EC2::VPC');
      expectDefaultTrainingTagsOnResource(props?.Tags as CfnTag[] | undefined);
    });

    test('propagates default training tags on the ASG (launch-time)', () => {
      const props = firstResourceProperties(template, 'AWS::AutoScaling::AutoScalingGroup');
      expectDefaultTrainingTagsPropagatedOnAsg(props?.Tags as CfnAsgTag[] | undefined);
    });

    test('applies default training tags to the ALB target group', () => {
      const props = firstResourceProperties(template, 'AWS::ElasticLoadBalancingV2::TargetGroup');
      expectDefaultTrainingTagsOnResource(props?.Tags as CfnTag[] | undefined);
    });
  });

  describe('web tier (ApacheBehindAlb)', () => {
    test('creates one Auto Scaling group wired to the ALB target group with ELB health checks', () => {
      template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
      template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
        MinSize: '2',
        MaxSize: '10',
        Cooldown: '120',
        HealthCheckType: 'ELB',
        HealthCheckGracePeriod: 300,
        TargetGroupARNs: [{ Ref: Match.stringLikeRegexp('WebAlbHttpListenerWebGroup') }],
        VPCZoneIdentifier: [{ Ref: Match.anyValue() }, { Ref: Match.anyValue() }],
        MetricsCollection: [{ Granularity: '1Minute' }],
      });
    });

    test('allows HTTP from the ALB security group to instances on port 80 only', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        Description: 'HTTP from load balancer',
      });
    });

    test('creates an internet-facing application load balancer with an HTTP listener', () => {
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
      });
    });

    test('target group uses HTTP health checks on / and instance targets', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 80,
        Protocol: 'HTTP',
        TargetType: 'instance',
        HealthCheckPath: '/',
        HealthCheckIntervalSeconds: 30,
        Matcher: { HttpCode: '200' },
      });
    });

    test('launch template uses t3.micro, IMDSv2, public IP, and bootstraps Apache', () => {
      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateData: {
          InstanceType: 't3.micro',
          MetadataOptions: {
            HttpTokens: 'required',
          },
          NetworkInterfaces: Match.arrayWith([
            Match.objectLike({
              AssociatePublicIpAddress: true,
            }),
          ]),
          UserData: Match.objectLike({
            'Fn::Base64': Match.stringLikeRegexp('httpd'),
          }),
        },
      });
    });

    test('instance role trusts EC2 and attaches SSM core policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'ec2.amazonaws.com' },
            }),
          ]),
        },
        ManagedPolicyArns: [
          {
            'Fn::Join': [
              '',
              ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore'],
            ],
          },
        ],
      });
    });
  });

  describe('scaling and observability (HttpScalingObservability)', () => {
    test('defines step scaling policies for scale-out and scale-in', () => {
      template.resourceCountIs('AWS::AutoScaling::ScalingPolicy', 2);
      template.hasResourceProperties('AWS::AutoScaling::ScalingPolicy', {
        PolicyType: 'StepScaling',
        AdjustmentType: 'ChangeInCapacity',
        MetricAggregationType: 'Average',
        EstimatedInstanceWarmup: 120,
        StepAdjustments: [{ MetricIntervalLowerBound: 0, ScalingAdjustment: 3 }],
      });
      template.hasResourceProperties('AWS::AutoScaling::ScalingPolicy', {
        PolicyType: 'StepScaling',
        StepAdjustments: [{ MetricIntervalUpperBound: 0, ScalingAdjustment: -1 }],
      });
    });

    test('creates CloudWatch alarms on HTTP load with SNS for alarm and OK transitions', () => {
      template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmDescription: 'Scale out when HTTP req/s per instance is at or above 50',
        Threshold: 50,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 2,
        DatapointsToAlarm: 2,
        TreatMissingData: 'notBreaching',
        Metrics: Match.arrayWith([
          Match.objectLike({
            Expression: 'perTarget / PERIOD(perTarget)',
          }),
        ]),
        OKActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp('HttpScalingHttpScalingAlarmsTopic') }]),
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmDescription: 'Scale in when HTTP req/s per instance is at or below 10',
        Threshold: 10,
        ComparisonOperator: 'LessThanOrEqualToThreshold',
        OKActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp('HttpScalingHttpScalingAlarmsTopic') }]),
      });
    });

    test('creates SNS topic for scaling alarms with CloudWatch publish policy', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        DisplayName: 'HTTP scaling alarms (scale out / scale in)',
      });
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sns:Publish',
              Effect: 'Allow',
              Principal: {
                Service: 'cloudwatch.amazonaws.com',
              },
            }),
          ]),
        },
      });
    });

    test('creates a named CloudWatch dashboard for HTTP and ASG operations', () => {
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'TestStack-http-asg',
      });
    });
  });

  describe('stack outputs', () => {
    test('exposes load balancer, dashboard, and scaling topic outputs', () => {
      template.hasOutput('LoadBalancerDns', {
        Description: Match.stringLikeRegexp('Apache'),
      });
      template.hasOutput('DashboardName', {
        Value: 'TestStack-http-asg',
      });
      template.hasOutput('ScalingAlarmsTopicArn', {
        Description: Match.stringLikeRegexp('SNS topic ARN'),
      });
    });

    test('with default props, exposes Locust driver outputs', () => {
      template.hasOutput('LocustInstancePublicDns', {
        Description: Match.stringLikeRegexp('Locust driver'),
      });
      template.hasOutput('LocustWebPort', {
        Value: '8089',
      });
    });
  });

  describe('Locust load generator', () => {
    test('provisions a standalone Locust EC2 instance with IMDSv2, SSM role, and Locust bootstrap user data', () => {
      template.resourceCountIs('AWS::EC2::Instance', 1);
      template.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 'm5.large',
      });
      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateName: 'InstanceLaunchTemplate',
        LaunchTemplateData: {
          MetadataOptions: {
            HttpTokens: 'required',
          },
        },
      });
      const resources = template.toJSON().Resources as Record<
        string,
        { Type?: string; Properties?: { UserData?: unknown } }
      >;
      const instance = Object.values(resources).find((r) => r.Type === 'AWS::EC2::Instance');
      expect(JSON.stringify(instance?.Properties?.UserData)).toMatch(/locust/);
    });

    test('creates a second EC2 instance profile role for the driver', () => {
      template.resourceCountIs('AWS::IAM::Role', 2);
    });
  });
});

describe('AutoscalingDemoStack with enableLocustDriver false', () => {
  test('omits Locust EC2, related outputs, and the second instance role', () => {
    const app = new cdk.App();
    const stack = new AutoscalingDemoStack(app, 'NoLocust', {
      enableLocustDriver: false,
    });
    const t = Template.fromStack(stack);

    t.resourceCountIs('AWS::EC2::Instance', 0);
    t.resourceCountIs('AWS::IAM::Role', 1);

    const outputs = t.toJSON().Outputs as Record<string, unknown> | undefined;
    expect(outputs).toBeDefined();
    expect(Object.keys(outputs!)).toEqual(
      expect.arrayContaining(['LoadBalancerDns', 'DashboardName', 'ScalingAlarmsTopicArn']),
    );
    expect(outputs).not.toHaveProperty('LocustInstancePublicDns');
    expect(outputs).not.toHaveProperty('LocustWebPort');
  });

  test('still provisions core web, scaling, and network resources', () => {
    const app = new cdk.App();
    const stack = new AutoscalingDemoStack(app, 'NoLocustCore', {
      enableLocustDriver: false,
    });
    const t = Template.fromStack(stack);

    t.resourceCountIs('AWS::EC2::VPC', 1);
    t.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });
});
