import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { AutoscalingDemoStack } from '../lib/autoscaling-demo-stack';

describe('AutoscalingDemoStack', () => {
  let app: cdk.App;
  let stack: AutoscalingDemoStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new AutoscalingDemoStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  test('creates one Auto Scaling group with ELB health checks and expected capacity', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '10',
      HealthCheckType: 'ELB',
    });
  });

  test('creates an internet-facing application load balancer', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('web tier launch template uses t3.micro and requires IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        InstanceType: 't3.micro',
        MetadataOptions: {
          HttpTokens: 'required',
        },
      },
    });
  });

  test('creates SNS topic for scaling alarms with CloudWatch publish policy', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      DisplayName: 'HTTP scaling alarms (scale out / scale in)',
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'sns:Publish',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudwatch.amazonaws.com',
            },
          },
        ],
      },
    });
  });

  test('creates CloudWatch dashboard and scaling alarms', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  test('enableLocustDriver false omits standalone Locust EC2 instance', () => {
    const appNoLocust = new cdk.App();
    const stackNoLocust = new AutoscalingDemoStack(appNoLocust, 'NoLocust', {
      enableLocustDriver: false,
    });
    const t = Template.fromStack(stackNoLocust);
    t.resourceCountIs('AWS::EC2::Instance', 0);
  });
});
