"""Expands shared blocks in app.template.yml into infra/stacks/app.yml.

CloudFormation does not accept YAML anchors, so the environment shared by
every backend container is written once here and stamped into each task.
Run: python infra/src/build.py
"""
from pathlib import Path

HERE = Path(__file__).parent

BACKEND_ENV = """Environment:
  - { Name: ENVIRONMENT, Value: aws }
  - { Name: DB_HOST, Value: !Ref DbEndpoint }
  - { Name: DB_PORT, Value: "3306" }
  - { Name: DB_NAME, Value: dispatchx }
  - { Name: REDIS_URL, Value: !Sub "redis://${CacheEndpoint}:6379/0" }
  - { Name: AWS_REGION, Value: !Ref AWS::Region }
  - { Name: SNS_TOPIC_ARN, Value: !Ref OrderEventsTopicArn }
  - { Name: NOTIFY_TOPIC_ARN, Value: !Ref NotifyTopicArn }
  - { Name: SQS_DISPATCH_QUEUE_URL, Value: !Ref DispatchQueueUrl }
  - { Name: SQS_NOTIFY_QUEUE_URL, Value: !Ref NotifyQueueUrl }
  - { Name: S3_BUCKET, Value: !Ref PodBucketName }
  - { Name: CELERY_POOL, Value: threads }
  - { Name: ECS_CLUSTER, Value: !Sub "${Project}-cluster" }
  - { Name: CELERY_CONCURRENCY, Value: "8" }
  - { Name: ENABLE_CHAOS_TESTS, Value: "true" }
Secrets:
  - { Name: DB_USER, ValueFrom: !Sub "${DbSecretArn}:username::" }
  - { Name: DB_PASSWORD, ValueFrom: !Sub "${DbSecretArn}:password::" }
  - { Name: JWT_SECRET, ValueFrom: !Ref JwtSecretArn }"""


def main():
    out = []
    for line in (HERE / "app.template.yml").read_text().splitlines():
        if line.strip() == "#BACKEND_ENV#":
            indent = line[: len(line) - len(line.lstrip())]
            out.extend(indent + l for l in BACKEND_ENV.splitlines())
        else:
            out.append(line)
    (HERE.parent / "stacks" / "app.yml").write_text("\n".join(out) + "\n")
    print("wrote infra/stacks/app.yml")


if __name__ == "__main__":
    main()
