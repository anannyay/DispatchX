import { ChevronRight, ExternalLink } from "lucide-react";
import { SOURCE_ROOT } from "@/lib/architecture";

const ROWS = [
  ["Runs the app", "Containers on one host", "Pods in a three-node kind cluster", "ECS tasks on EC2 instances"],
  ["Routes requests", "Published ports 3000 / 8000", "NGINX Ingress → Services", "CloudFront → ALB → ECS targets"],
  ["Stores orders", "MySQL container + named volume", "MySQL StatefulSet + PVC", "Amazon RDS MySQL"],
  ["Coordinates work", "Redis container", "Redis Deployment", "Amazon ElastiCache (Valkey)"],
  ["Delivers domain events", "Celery through Redis", "Celery through Redis", "SNS → SQS → consumer / Lambda"],
  ["Adds capacity", "Manual; one host", "HPA changes pod counts; fixed nodes", "Service scaling + EC2 capacity provider"],
  ["Stores delivery photos", "API upload volume", "API pod disk; not shared or durable", "Direct signed uploads to Amazon S3"],
];

export default function DeploymentComparison() {
  return (
    <details className="explorer-comparison">
      <summary><ChevronRight size={16} /><span>How the deployment environments compare<small>Same application responsibilities. Different infrastructure.</small></span></summary>
      <p>Docker builds and packages the application. Compose runs it locally. Kubernetes and ECS are <strong>alternative orchestrators</strong> here—not nested layers of the AWS deployment. AWS provides compute, managed data, messaging, and the public entry point. This project does not deploy to EKS.</p>
      <div className="explorer-comparison-scroll" tabIndex={0} role="region" aria-label="Deployment comparison table; scroll horizontally on smaller screens">
        <table>
          <caption className="sr-only">Repository-defined defaults; not live resource measurements</caption>
          <thead><tr><th scope="col">Responsibility</th><th scope="col">Docker Compose</th><th scope="col">Kubernetes · local / CI</th><th scope="col">AWS · ECS on EC2</th></tr></thead>
          <tbody>{ROWS.map(([label, ...values]) => <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td key={i}>{value}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="explorer-comparison-sources">Verify the configuration:
        {["docker-compose.yml", "k8s/README.md", "infra/main.yml"].map((source) => <a key={source} href={`${SOURCE_ROOT}${source}`} target="_blank" rel="noreferrer">{source}<ExternalLink size={11} /></a>)}
      </div>
    </details>
  );
}
