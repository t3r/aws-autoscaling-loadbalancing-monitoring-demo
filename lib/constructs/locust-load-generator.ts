import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface LocustLoadGeneratorProps {
  readonly vpc: ec2.IVpc;
  /** Locust `--host` (typically the regional ALB HTTP URL). */
  readonly targetBaseUrl: string;
  readonly webUiPort?: number;
}

/**
 * Single EC2 instance running Locust (venv + systemd) for optional browser-driven load tests.
 */
export class LocustLoadGenerator extends Construct {
  public readonly instance: ec2.Instance;
  public readonly webUiPort: number;

  constructor(scope: Construct, id: string, props: LocustLoadGeneratorProps) {
    super(scope, id);

    const webUiPort = props.webUiPort ?? 8089;
    this.webUiPort = webUiPort;

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Locust driver',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'Role', {
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

    const systemdUnit = `[Unit]
Description=Locust load generator (web UI + workers on this host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/locust/locust.env
ExecStart=/bin/bash -lc 'set -a; source /opt/locust/locust.env; set +a; exec /opt/locust/venv/bin/python -m locust -f /opt/locust/locustfile.py --host "$LOCUST_TARGET" --web-host 0.0.0.0 --web-port ${webUiPort}'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf -y install python3 python3-pip gcc make python3-devel openssl-devel',
      'mkdir -p /opt/locust',
      'python3 -m venv /opt/locust/venv',
      '/opt/locust/venv/bin/pip install --upgrade pip',
      '/opt/locust/venv/bin/pip install "locust>=2.24,<3"',
      `echo "LOCUST_TARGET=${props.targetBaseUrl}" > /opt/locust/locust.env`,
      `echo '${Buffer.from(locustPy, 'utf-8').toString('base64')}' | base64 -d > /opt/locust/locustfile.py`,
      `echo '${Buffer.from(systemdUnit, 'utf-8').toString('base64')}' | base64 -d > /etc/systemd/system/locust.service`,
      'chmod 644 /etc/systemd/system/locust.service',
      'systemctl daemon-reload',
      'systemctl enable locust.service',
      'systemctl start locust.service',
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role,
      associatePublicIpAddress: true,
      userData,
      requireImdsv2: true,
    });
  }
}
