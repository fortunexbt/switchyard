from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings for the deliberately local, offline proof mode."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="SWITCHYARD_",
        extra="ignore",
        validate_default=True,
    )

    app_name: str = "Switchyard"
    environment: str = "local"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    database_url: str = "sqlite:///./switchyard.db"
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    trusted_hosts: str = "127.0.0.1,localhost,testserver"
    initial_stop: bool = False
    receipt_limit: int = Field(default=50, ge=1, le=200)
    max_content_length: int = Field(default=16_384, ge=1_024, le=1_048_576)

    @property
    def allowed_origins(self) -> list[str]:
        return _split_csv(self.cors_origins)

    @property
    def allowed_hosts(self) -> list[str]:
        return _split_csv(self.trusted_hosts)


def _split_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


def clear_settings_cache() -> None:
    get_settings.cache_clear()
