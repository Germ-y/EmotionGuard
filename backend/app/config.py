from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    port: int = 8000
    cors_origin: str = "http://localhost:4003,http://127.0.0.1:4003"
    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_transcription_model: str = "whisper-1"
    openai_max_tokens: int = 120
    emotion_model_path: str = "data/skt/skt_emotion_model.json"

    model_config = SettingsConfigDict(env_file="backend/.env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origin.split(",") if origin.strip()]


settings = Settings()
