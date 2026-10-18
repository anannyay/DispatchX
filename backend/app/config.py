from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "FleetPulse"
    environment: str = "local"

    # Database: either a full URL, or the parts (ECS injects DB_PASSWORD from Secrets Manager)
    database_url: str | None = None
    db_host: str = "localhost"
    db_port: int = 3306
    db_name: str = "fleetpulse"
    db_user: str = "fleetpulse"
    db_password: str = "fleetpulse"

    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "dev-secret-change-me"
    jwt_access_minutes: int = 30
    jwt_refresh_days: int = 7

    cors_origins: str = "*"

    # AWS integrations. When unset the app falls back to local equivalents,
    # so the whole stack runs on a laptop with only MySQL + Redis.
    aws_region: str = "us-east-1"
    sns_topic_arn: str | None = None           # order-events topic (fan-out to SQS)
    notify_topic_arn: str | None = None        # customer notifications (email/SMS)
    sqs_dispatch_queue_url: str | None = None
    sqs_notify_queue_url: str | None = None
    s3_bucket: str | None = None               # proof-of-delivery photos
    local_upload_dir: str = "/tmp/fleetpulse-uploads"
    public_api_url: str = "http://localhost:8000"

    # Dispatch tuning
    dispatch_radii_km: str = "3,6,12,25"
    offer_timeout_s: int = 20
    max_dispatch_attempts: int = 12
    base_fare: float = 30.0
    per_km_fare: float = 12.0
    avg_speed_kmh: float = 22.0

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"mysql+pymysql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}?charset=utf8mb4"
        )

    @property
    def radii(self) -> list[float]:
        return [float(r) for r in self.dispatch_radii_km.split(",")]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
