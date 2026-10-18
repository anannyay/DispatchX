# DispatchX on AWS

Everything is infrastructure as code (CloudFormation) and deployed by GitHub Actions.
The pipeline authenticates with an IAM access key stored as encrypted GitHub Actions secrets
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). OIDC federation would be preferable, but the
account's Free plan blocks `iam:CreateOpenIDConnectProvider`.

## Architecture

```
 Users ──HTTPS──▶ CloudFront ──(secret X-Origin-Verify header)──▶ ALB + WAF  [public subnets]
                   │ edge-caches /_next/static                     │
                   │ WebSockets pass through                       ▼
                   │                         ECS cluster on EC2 Auto Scaling group  [private app subnets, 2 AZs]
                   │                         ├─ api (FastAPI + Socket.IO)  ×2–8  ◀─ CPU target tracking
                   │                         ├─ web (Next.js)               ×2
                   │                         ├─ worker (Celery)             ×1–3
                   │                         ├─ beat (Celery Beat)          ×1
                   │                         ├─ consumer (SQS)              ×1–4 ◀─ SQS backlog target tracking
                   │                         └─ monitoring (Prometheus + Grafana, /grafana)
                   │                                   │                     │
                   ▼                                   ▼                     ▼
             S3 (POD photos) ◀─presigned PUT─   RDS MySQL 8.4         ElastiCache (Valkey)  [isolated data subnets]
                   │                             (Multi-AZ toggle)     geo-index, pub/sub, broker
                   └─EventBridge─▶ Lambda (validate photo)

 SNS order-events ──▶ SQS dispatch ──▶ consumer      (filter policy, DLQ)
                  ├─▶ SQS notify   ──▶ consumer ──▶ SNS email
                  └─▶ SQS analytics ─▶ Lambda ──▶ S3 data lake ──▶ Glue catalog ──▶ Athena
 CloudWatch: dashboard, alarms ──▶ SNS alerts (email); Container Insights; VPC flow logs
```

| Stack | File | Contents |
|---|---|---|
| bootstrap | `bootstrap.yml` | ECR repos and artifacts bucket (deployed once by hand) |
| parent | `main.yml` | Wires the nested stacks together |
| network | `stacks/network.yml` | VPC, 6 subnets in 2 AZs, IGW, NAT, route tables, data-tier NACL, S3 gateway endpoint, security groups, flow logs |
| data | `stacks/data.yml` | RDS MySQL, ElastiCache, S3 buckets, Secrets Manager |
| messaging | `stacks/messaging.yml` | SNS topics, SQS queues + DLQs, filter policies |
| app | `stacks/app.yml` | ECS cluster, ASG + capacity provider, ALB, WAF, Cloud Map, task definitions, services, auto scaling |
| edge | `stacks/edge.yml` | CloudFront distribution |
| analytics | `stacks/analytics.yml` | Lambda ingest, Glue table, Athena workgroup + saved queries, POD validator Lambda |
| observability | `stacks/observability.yml` | CloudWatch dashboard + alarms |

`stacks/app.yml` is generated from `src/app.template.yml` by `python infra/src/build.py`
(CloudFormation does not accept YAML anchors, so the shared container environment is stamped in).

## First-time setup (once)

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/anannyay/DispatchX/main/infra/bootstrap.yml -OutFile bootstrap.yml
aws cloudformation deploy --template-file bootstrap.yml --stack-name dispatchx-bootstrap --capabilities CAPABILITY_NAMED_IAM --region ap-southeast-2
```

Then add the two repository secrets under GitHub → Settings → Secrets and variables → Actions.

After that, every push to `main` that touches the app or infra runs **Test → Build images → Deploy → Seed → Smoke test**.
The first deploy takes about 25–30 minutes (RDS, ElastiCache and CloudFront are the slow parts).
Later deploys take about 8 minutes.

## Day-to-day

| Task | How |
|---|---|
| Deploy | Push to `main`, or Actions → *Deploy to AWS* → Run workflow |
| Turn on high availability for the demo | Run *Deploy to AWS* with `db_multi_az=true`, `cache_replicas=true` |
| Tear everything down | Actions → *Destroy AWS stack* → type `destroy` |
| App URL | Stack output `AppUrl`, or the deploy run's summary |
| Grafana admin password | `aws secretsmanager get-secret-value --secret-id <GrafanaSecretArn output> --query SecretString --output text` |
| Load test | `python simulator/simulator.py --base-url <AppUrl> --riders 300 --orders-per-min 120` |

## Cost (ap-southeast-2 Sydney, approximate)

| Item | Per day |
|---|---|
| 2 × t3.small ECS hosts | ~$1.10 |
| NAT Gateway | ~$1.35 + data |
| ALB | ~$0.60 |
| RDS db.t4g.micro (single-AZ) | ~$0.40 |
| ElastiCache cache.t3.micro | ~$0.40 |
| WAF (1 ACL + 4 rules) | ~$0.30 |
| CloudWatch, Container Insights, Lambda, S3, SQS, SNS, CloudFront | < $0.50 |
| **Total** | **~$4–5/day**. Destroy between work sessions. |
