# DispatchX on a local Kubernetes cluster (kind). Windows PowerShell.
# Prereqs: Docker Desktop running, kind and kubectl installed (see k8s/README.md).
# Run from the repository root:   powershell -ExecutionPolicy Bypass -File k8s\up.ps1
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

Step "Creating 3-node kind cluster (1 control plane + 2 workers)"
$existing = kind get clusters 2>$null
if ($existing -notcontains "dispatchx") { kind create cluster --config k8s/kind-config.yaml }
kubectl config use-context kind-dispatchx | Out-Null

Step "Installing NGINX ingress controller and metrics-server"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json --patch-file k8s/addons/metrics-server-patch.json

Step "Building Docker images"
docker build -t dispatchx/backend:local backend
docker build -t dispatchx/web:local frontend

Step "Loading images into the cluster nodes"
kind load docker-image dispatchx/backend:local dispatchx/web:local --name dispatchx

Step "Waiting for the ingress controller"
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=180s

Step "Deploying DispatchX (kubectl apply -k k8s)"
kubectl apply -k k8s
kubectl -n dispatchx rollout status statefulset/mysql --timeout=300s
kubectl -n dispatchx rollout status deployment/api --timeout=300s
kubectl -n dispatchx rollout status deployment/web --timeout=300s
kubectl -n dispatchx wait --for=condition=complete job/seed --timeout=300s

Step "Done"
kubectl -n dispatchx get pods -o wide
Write-Host "`nApp:          http://localhost:8080   (login as Dispatcher, open 'Cluster view')"
Write-Host "Watch pods:   kubectl -n dispatchx get pods -o wide -w"
Write-Host "Watch HPA:    kubectl -n dispatchx get hpa -w"
Write-Host "Load test:    python simulator/simulator.py --base-url http://localhost:8080 --riders 120 --orders-per-min 60"
