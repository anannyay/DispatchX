# DispatchX on Kubernetes

The AWS deployment runs on **Amazon ECS** (see `infra/`). This folder runs the **same Docker images**
on **Kubernetes**: locally with [kind](https://kind.sigs.k8s.io/) (Kubernetes-in-Docker), 3 nodes, at no cost.
CI deploys it on every push (`.github/workflows/k8s.yml`) and runs the end-to-end test through the ingress.

## One-time install (Windows)

```powershell
# Docker Desktop must be installed and running
winget install Kubernetes.kind
winget install Kubernetes.kubectl
winget install Headlamp.Headlamp      # optional: visual Kubernetes dashboard
```
macOS: `brew install kind kubectl && brew install --cask headlamp`

## Run it

```powershell
# from the repository root
powershell -ExecutionPolicy Bypass -File k8s\up.ps1      # Windows
./k8s/up.sh                                             # macOS / Linux
```
The first run takes about 5–8 minutes (image builds). Then open **http://localhost:8080**, log in as **Dispatcher**,
and open **Cluster view**: it detects Kubernetes and draws the 3 nodes and their pods.
Delete everything with `kind delete cluster --name dispatchx`.

## Demo script (5 minutes)

1. **Show the cluster:** `kubectl -n dispatchx get pods -o wide`. API and web pods are spread across `zone-a` and `zone-b`.
2. **Open Headlamp** (or the app's Cluster view) next to a terminal running `kubectl -n dispatchx get hpa -w`.
3. **Generate load:** `python simulator/simulator.py --base-url http://localhost:8080 --riders 120 --orders-per-min 60`
4. **Watch the autoscaler:** the HPA target goes above 50% CPU and the `api` Deployment grows from 2 towards 8 pods.
   New pods appear in Cluster view with a NEW badge, and the NGINX ingress spreads traffic to them.
5. **Self-healing:** click a pod in Cluster view → *Kill this pod*, or run `kubectl -n dispatchx delete pod <name>`.
   The Deployment controller creates a replacement within seconds, while live tracking keeps working
   (Socket.IO state lives in Redis, not in the pod).
6. **Stop the simulator:** after the 90 s stabilisation window the HPA scales back down to 2.

## What's in here

| File | Kubernetes object | Role |
|---|---|---|
| `kind-config.yaml` | kind Cluster | 1 control plane + 2 workers labelled as zones; host port 8080 → ingress |
| `config.yaml` | ConfigMap + Secret | Environment variables and credentials |
| `rbac.yaml` | ServiceAccount, Role, ClusterRole + bindings | Least-privilege API access for Cluster view |
| `mysql.yaml` | StatefulSet + headless Service + PVC | Database with a persistent volume |
| `redis.yaml` | Deployment + Service | Geo-index, Socket.IO pub/sub, Celery broker |
| `api.yaml` | Deployment + Service | FastAPI + Socket.IO, readiness/liveness probes, zone spreading |
| `worker.yaml`, `beat.yaml` | Deployments | Celery workers; Beat uses the `Recreate` strategy so only one scheduler ever runs |
| `web.yaml` | Deployment + Service | Next.js frontend |
| `ingress.yaml` | Ingress (NGINX) | `/api` and `/socket.io` → api (cookie affinity, long timeouts), `/` → web |
| `hpa.yaml` | HorizontalPodAutoscaler | api 2–8 pods at 50% CPU, worker 1–3 pods at 70% CPU |
| `seed-job.yaml` | Job | Migrations + demo accounts |

## ECS (AWS deployment) ↔ Kubernetes (this folder)

| Concept | Amazon ECS (production on AWS) | Kubernetes (local / CI) |
|---|---|---|
| Unit of deployment | Task (one or more containers) | Pod |
| Spec | Task definition | Pod template in a Deployment |
| Keep N copies running | ECS Service | Deployment / ReplicaSet |
| Machines | EC2 container instances in an Auto Scaling group | Nodes |
| Add machines when full | Capacity provider managed scaling | Cluster Autoscaler / Karpenter |
| Add copies under load | Service auto scaling (target tracking, CPU 60%) | HorizontalPodAutoscaler (CPU 50%) |
| Scale on queue depth | Target tracking on SQS `ApproximateNumberOfMessagesVisible` | KEDA SQS scaler |
| Load balancing | Application Load Balancer + target groups | Ingress (NGINX) + Services |
| Service discovery | AWS Cloud Map (DNS SRV) | Cluster DNS (`api.dispatchx.svc`) |
| Config / secrets | Task env vars + Secrets Manager | ConfigMap + Secret |
| Health checks | ALB target health + circuit breaker rollback | Readiness / liveness probes + rolling update |
| Permissions | IAM task role | ServiceAccount + RBAC |
| Spread across failure domains | Placement strategy `spread(availability-zone)` | `topologySpreadConstraints` on zone |
| One-off job | `ecs run-task` (seed) | Job |
| Database | RDS MySQL (managed, Multi-AZ) | StatefulSet + PersistentVolume |

**Why ECS on AWS?** It is fully managed with no control-plane fee (EKS costs about $73/month just for the
control plane), it integrates natively with ALB, IAM, Cloud Map and CloudWatch, and the account's
Free plan rules out the extra spend. Kubernetes provides portability, and because the images are
identical, moving to EKS later only means pointing these manifests at an EKS cluster.
