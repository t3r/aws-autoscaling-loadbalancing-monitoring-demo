# autoscaling-demo

AWS CDK (TypeScript) project that provisions a **demo HTTP stack**: an **Application Load Balancer** in front of an **Auto Scaling group** of **Amazon Linux 2023** instances running **Apache**, with **CloudWatch**–driven **step scaling**, an **operations dashboard**, **SNS notifications** for scaling alarms, and an optional **Locust** driver EC2 instance for load testing. You can optionally deploy **two copies of that stack in different regions** plus a **Route53 weighted DNS** stack that targets both ALBs with **per-endpoint HTTP health checks**, so DNS stops returning an unhealthy region after health checks fail.

---

## Architecture (ASCII)

**Where clients send traffic**

- **Single stack** — HTTP to the stack output **LoadBalancerDns** (one regional ALB).
- **Multi-region** (`-c multiRegion=true`) — HTTP to **WeightedDnsRecordFqdn**. **Route 53** publishes **weighted A alias** records (default **50 / 50**) toward each region’s ALB, each with an **HTTP health check** on the ALB (`GET /`). If checks fail for an endpoint, that weighted answer is **omitted**, so resolvers only return **healthy** regions—**DNS-level failover** (subject to TTL and health-check timing). The **global DNS** stack (`AutoscalingDemoGlobalDns`) is synthesized in **`dnsStackRegion`** (default: primary); health-check **CloudWatch metrics** are read from **us-east-1** regardless.

![Architecture Diagram (simplified)](/img/architecture.png)

**Traffic flow**

1. **Single stack:** Clients (browser, **Locust**, or `curl`) send **HTTP** to the **ALB DNS name** on port **80**.
2. **Multi-region:** Clients use the **global hostname**; **Route 53** returns A records for **healthy** regional ALBs only, then the same path as (1) inside that region’s VPC.
3. The ALB forwards to **healthy** instances in the **target group** (registered by the ASG).
4. Each instance serves a small **HTML** page built at boot from **IMDS** (instance id + private DNS).

**Control plane**

- **CloudWatch** (in **each** regional stack) evaluates a **math expression** on **ALB `RequestCountPerTarget`** (≈ load per healthy target, expressed as **requests per second**).
- **Two alarms** drive **step scaling** policies (**+3** capacity when sustained **≥ 50** req/s per target, **−1** when sustained **≤ 10**). Each alarm also **notifies an SNS topic** on **ALARM** and **OK**.
- A **CloudWatch dashboard** (name matches stack output **DashboardName**, typically `YOUR-CDK-STACK-NAME-http-asg`) plots that metric and **`GroupInServiceInstances`**.
- With **multi-region**, add **Route53HealthDashboardName** for **Route 53** health-check status / **% healthy** checkers per endpoint.

---

## What this stack creates

| Area | Resources |
|------|------------|
| **Network** | VPC, 2 public subnets (no public auto-assign on subnet; instances use ENI public IP where configured), Internet Gateway, routes. |
| **Compute (app)** | Launch template: **Amazon Linux 2023**, **t3.micro**, user data installs **httpd** + static `index.html`, **IMDSv2 required**, **public IPv4**, **SSM** instance profile. **ASG**: **min 2**, **max 10**, **ELB** health checks, **2 min** default cooldown, **group metrics** enabled. |
| **Load balancing** | Internet-facing **ALB**, HTTP **:80** listener, **target group** → ASG, health check **`/`** expecting **200**. |
| **Scaling** | CloudWatch **alarms** (2×1 min periods, 2 breaching datapoints). **Scale out**: **+3** instances. **Scale in**: **−1**. |
| **Observability** | **Dashboard** + **SNS topic** for alarm **ALARM** and **OK**. |
| **Load generator** | Standalone **m5.large** with **Locust** in a **venv**, **systemd** service, `--web-host 0.0.0.0`, target URL = **ALB** from `/opt/locust/locust.env`. |
| **Tagging** | Stack tags + propagated tags: `t3r:training`, `t3r:purpose`, `t3r:remove-after` (see `lib/autoscaling-demo-stack.ts`). |

**Costs (high level)**
You pay for **EC2**, **EBS**, **ALB**, **data transfer**, **CloudWatch** (dashboard / custom metrics / alarms), **SNS**, and the **m5 Locust** instance. **NAT gateways are not** used in this VPC layout.

---

## Prerequisites

- **Node.js** and **npm**
- **AWS CLI** configured with credentials and a default region (or explicit env)
- **CDK bootstrap** once per account/region:
  `npx cdk bootstrap aws://ACCOUNT/REGION`

---

## Build and deploy

```bash
npm install
npm run build
npx cdk synth          # optional: validate template
npx cdk deploy         # prompts for IAM approval unless --require-approval never
```

### Stack environment (account / region)

By default `bin/autoscaling-demo.ts` does **not** pin `env`; the stack is environment-agnostic at synth time and deploys to whatever the CLI resolves.

To fix account/region, edit `bin/autoscaling-demo.ts` and uncomment **one** of:

```typescript
env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
```

or an explicit account/region pair.

### Multi-region + global Route53 (optional)

When CDK context **`multiRegion`** is enabled (`true` in `cdk.json`, or `-c multiRegion=true` on the CLI — string values count as enabled), the app synthesizes **three** stacks:

| Stack | Region (default) | Role |
|--------|------------------|------|
| `AutoscalingDemo-<primaryRegion>` | `eu-central-1` (see `bin/autoscaling-demo.ts` / context) | Full demo stack including the **Locust** driver (`enableLocustDriver` default). |
| `AutoscalingDemo-<secondaryRegion>` | `eu-west-3` (see bin / context) | Same app tier (VPC, ASG, ALB, scaling, dashboard) **without** a Locust instance — load generation runs from the primary region only. |
| `AutoscalingDemoGlobalDns` | `primaryRegion` (override with `dnsStackRegion`) | **Weighted A alias** records for `dnsRecordName` + `hostedZoneName`, each tied to a regional ALB and a **Route53 HTTP health check** on `http://<alb-dns>/`. |

The primary stack’s Locust user data still targets the **primary regional ALB** by default. To load-test via the **global** hostname (both regions through Route53), SSH or SSM into the primary Locust instance and set `LOCUST_TARGET` in `/opt/locust/locust.env` to `http://YOUR-WEIGHTED-DNS-RECORD`, then `sudo systemctl restart locust.service`.

**Required context** (when `multiRegion` is enabled):

- **`account`** — 12-digit AWS account id (or set **`CDK_DEFAULT_ACCOUNT`** and omit `account` if your CLI provides it).
- **`hostedZoneId`** — existing **public** hosted zone id (starts with `Z`).
- **`hostedZoneName`** — zone apex name (e.g. `example.com`).

**Optional context**: `primaryRegion`, `secondaryRegion`, `dnsStackRegion`, `dnsRecordName` (default subdomain `demo` → `demo.example.com`).

All three stacks use **`crossRegionReferences: true`** so the DNS stack can reference ALBs in other regions (CDK publishes exports to **SSM**; bootstrap must be current in each involved region).

**Bootstrap** (once per account **and** region used):

```bash
npx cdk bootstrap aws://ACCOUNT/PRIMARY_REGION
npx cdk bootstrap aws://ACCOUNT/SECONDARY_REGION
```

**Deploy everything**:

```bash
npx cdk deploy --all \
  -c multiRegion=true \
  -c account=ACCOUNT \
  -c hostedZoneId=Zxxxxxxxxxxxx \
  -c hostedZoneName=example.com
```

Point your domain at the hosted zone’s **Route53 name servers** (if you have not already) so clients resolve `dnsRecordName.hostedZoneName` to the weighted record.

**Output**: stack `AutoscalingDemoGlobalDns` exports **`WeightedDnsRecordFqdn`** (e.g. `demo.example.com`). Open `http://WeightedDnsRecordFqdn/` to hit whichever regional ALBs are **healthy**; with equal weights (50/50), traffic is split across healthy endpoints only. It also exports **`Route53HealthDashboardName`**: open that dashboard in **CloudWatch** to see **HealthCheckStatus** (1/0) and **HealthCheckPercentageHealthy** for each regional endpoint (metrics are read from **us-east-1** even if the dashboard stack lives elsewhere).

**Simulating a regional failure**: stop or delete resources in one region until the ALB stops returning **2xx** on `/` (for example delete the stack in that region, remove the listener, or block the ALB security group). Route53 health checks flip to **unhealthy** after consecutive failures; that region’s **weighted record is omitted** from DNS responses, so clients converge on the surviving region (allow a few minutes for TTLs and health-check intervals).

### Useful outputs after deploy

| Output | Meaning |
|--------|---------|
| **LoadBalancerDns** | Open `http://YOUR-ALB-DNS/` in a browser (use the output value). |
| **DashboardName** | **CloudWatch → Dashboards**: HTTP load per instance, **Auto Scaling activity** (desired / in-service / pending / terminating), and scaling thresholds. |
| **ScalingAlarmsTopicArn** | Subscribe (email/SMS) for scaling alarm **ALARM** / **OK**. |
| **LocustInstancePublicDns** | Locust host DNS (after you open the SG). Omitted when `enableLocustDriver` is false (multi-region **secondary** stack). |
| **LocustWebPort** | **8089** — Locust web UI. Omitted when no Locust driver is deployed. |
| **WeightedDnsRecordFqdn** | (Multi-region only) Hostname for the weighted global record — use `http://…/` in a browser. |
| **Route53HealthDashboardName** | (Multi-region only) CloudWatch dashboard for **Route 53** health-check status and **% healthy** checkers per endpoint. |

---

## Configure manually (after deploy)

### 1. Locust driver security group — inbound

The **Locust** instance security group is created with **no inbound rules** (outbound is open). Add rules as needed, for example:

- **TCP 8089** from **your IP** / office / VPN CIDR → use the Locust **web UI** from your laptop:
  `http://PUBLIC-DNS-OF-LOCUST-DRIVER:8089` (use **LocustInstancePublicDns** output)
- Optionally **TCP 22** if you use SSH (not defined by this stack).

### 2. SNS subscription

1. Copy **ScalingAlarmsTopicArn** from stack outputs (or CloudFormation **Outputs**).
2. In **SNS → Topics →** select topic **→ Create subscription**.
3. Choose **Email** (or SMS where supported), confirm the **email** link.

You receive messages when **scale-out** or **scale-in** alarms enter **ALARM** or return to **OK**.

### 3. Optional: `bin/autoscaling-demo.ts`

Uncomment **`env`** if you rely on lookups or want deterministic account/region in the template.

### 4. Optional: Locust on your laptop instead of the EC2 driver

See **`loadgen/locustfile.py`** (header comments): Python venv, `pip install -r requirements.txt`, then `locust -f locustfile.py --host http://YOUR-ALB-DNS`.

---

## Demonstration: automatic recovery before a load test

Goal: show that a **failed or unhealthy** app instance is **replaced** by the ASG (with **ELB** health checks), **before** you run Locust and watch **scale-out** behavior.

### Why this works

- The ASG registers instances in the **target group**.
- The ALB marks targets **unhealthy** if **`GET /`** does not return **200** within the health check settings.
- The ASG uses **ELB** as an additional health check type: an instance that stays **unhealthy** can be **terminated and replaced** so capacity and healthy targets recover toward **min / desired** (see **Auto Scaling** → **Activity** in the console for exact behavior).

### Steps (recommended order)

1. **Deploy** the stack and wait until **two** instances are **healthy** in the target group (ALB → target groups → **Healthy** count = **2** if `minCapacity` is **2**).

2. **Open the dashboard** (output **DashboardName**): watch **“Auto Scaling — instances in service”** (and optionally the **EC2** console filtered by this stack’s instances).

3. **Break one app instance** (pick an instance that is **InService** behind the ALB), for example via **SSM Session Manager** (instances have **AmazonSSMManagedInstanceCore**):
   - **Stop Apache** so health checks fail:
     `sudo systemctl stop httpd`
     or **`sudo shutdown -h now`** if you want a harder failure (ASG will replace a terminated instance to satisfy capacity).

4. **Watch** (2–5+ minutes depending on health check interval, grace, and replacement):
   - **Target group**: unhealthy → new instance **registering** → **healthy**.
   - **ASG**: **InService** count may dip then return to **2** (or current desired).
   - **Dashboard**: **GroupInServiceInstances** should reflect recovery.

5. **Confirm** `http://YOUR-ALB-DNS/` still serves traffic (refresh may hit the surviving healthy instance during replacement).

6. **Then** start your **load test** (Locust on the driver EC2 or locally) and observe **HTTP req/s per instance** and **instance count** as load crosses **50** / **10** thresholds.

### What you should see during load test

- **CloudWatch dashboard**: the **math metric** rises with load;
![CloudWatch dashboard](/img/dashboard.jpg)
**GroupInServiceInstances** may increase when the **scale-out** alarm fires (**+3** per policy in the current code).
- When load drops, the **scale-in** alarm can fire (**−1** per evaluation).
- **SNS**: notifications on **ALARM** and **OK** for both alarms (if subscribed).

> **Note:** Step scaling and alarm timing depend on **sustained** metric values (two 1-minute evaluation periods, two breaching datapoints) and **ASG cooldown** / **warm-up** settings. Instant spikes may not immediately change capacity.

---

## Local load generator (`loadgen/`)

```bash
cd loadgen
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
locust -f locustfile.py --host http://YOUR-ALB-DNS
```

Then open **http://localhost:8089** (Locust UI), set users/spawn rate, start.

---

## Development commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript (`tsc`). |
| `npm run watch` | Watch mode compile. |
| `npm test` | Run Jest tests. |
| `npx cdk synth` | Synthesize CloudFormation. |
| `npx cdk diff` | Diff deployed stack vs template. |
| `npx cdk deploy` | Deploy the stack. |

---

## Customizing the stack

Edit **`lib/autoscaling-demo-stack.ts`**: instance sizes, **min/max** capacity, **scaling thresholds** (50 / 10), **step adjustments** (+3 / −1), **cooldown**, **dashboard** name, **training tags**, etc. Then `npm run build` and `cdk deploy`.

---

## Destroy

```bash
npx cdk destroy
```

Empty **S3** bootstrap buckets / **ECR** only if you created them outside this app; this stack does not define a data bucket for the demo app.

---

## References

- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [Auto Scaling health checks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/healthcheck.html)
- [ALB target group health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [Locust documentation](https://docs.locust.io/)
