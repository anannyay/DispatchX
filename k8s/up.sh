#!/usr/bin/env bash
# DispatchX on a local Kubernetes cluster (kind). macOS / Linux / Git Bash.
# Run from the repository root:   ./k8s/up.sh
set -euo pipefail
step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

step "Creating 3-node kind cluster (1 control plane + 2 workers)"
kind get clusters 2>/dev/null | grep -qx dispatchx || kind create cluster --config k8s/kind-config.yaml
kubectl config use-context kind-dispatchx >/dev/null

step "Installing NGINX ingress controller and metrics-server"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json --patch-file k8s/addons/metrics-server-patch.json

step "Building Docker images"
docker build -t dispatchx/backend:local backend
docker build -t dispatchx/web:local frontend

step "Loading images into the cluster nodes"
kind load docker-image dispatchx/backend:local dispatchx/web:local --name dispatchx

step "Waiting for the ingress controller"
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=180s

step "Deploying DispatchX (kubectl apply -k k8s)"
kubectl apply -k k8s
kubectl -n dispatchx rollout status statefulset/mysql --timeout=300s
kubectl -n dispatchx rollout status deployment/api --timeout=300s
kubectl -n dispatchx rollout status deployment/web --timeout=300s
kubectl -n dispatchx wait --for=condition=complete job/seed --timeout=300s

step "Done"
kubectl -n dispatchx get pods -o wide
echo
echo "App:          http://localhost:8080   (login as Dispatcher, open 'Cluster view')"
echo "Watch pods:   kubectl -n dispatchx get pods -o wide -w"
echo "Watch HPA:    kubectl -n dispatchx get hpa -w"
echo "Load test:    python simulator/simulator.py --base-url http://localhost:8080 --riders 120 --orders-per-min 60"
