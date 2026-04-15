import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ApacheBehindAlbProps {
  readonly vpc: ec2.IVpc;
}

/**
 * Apache on EC2 (launch template + ASG) behind an internet-facing ALB and target group.
 * Classic “stateless web tier” pattern: only the load balancer may reach instances on :80.
 */
export class ApacheBehindAlb extends Construct {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly webTargetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: ApacheBehindAlbProps) {
    super(scope, id);
    const { vpc } = props;

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

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: apacheUserData(),
      securityGroup: instanceSecurityGroup,
      role: instanceRole,
      associatePublicIpAddress: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });

    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 2,
      maxCapacity: 10,
      cooldown: cdk.Duration.minutes(2),
      groupMetrics: [autoscaling.GroupMetrics.all()],
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        gracePeriod: cdk.Duration.minutes(5),
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
      }),
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    instanceSecurityGroup.connections.allowFrom(
      this.loadBalancer,
      ec2.Port.tcp(80),
      'HTTP from load balancer',
    );

    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    this.webTargetGroup = listener.addTargets('Web', {
      port: 80,
      targets: [this.autoScalingGroup],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });
  }
}

function apacheUserData(): ec2.UserData {
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
  return userData;
}
