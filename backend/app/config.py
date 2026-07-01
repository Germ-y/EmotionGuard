from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    port: int = 8000
    cors_origin: str = "http://localhost:4003"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    anthropic_max_tokens: int = 80

    model_config = SettingsConfigDict(env_file="backend/.env", env_file_encoding="utf-8")


settings = Settings()
