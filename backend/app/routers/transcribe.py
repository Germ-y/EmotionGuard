from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.models import TranscribeResponse
from app.services.openai import transcribe_audio_with_openai


router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])


@router.post("", response_model=TranscribeResponse)
async def transcribe(file: UploadFile = File(...), prompt: str = Form("")) -> TranscribeResponse:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio file is too large")

    try:
        return await transcribe_audio_with_openai(
            file.filename or "demo-audio.mp3",
            content,
            file.content_type,
            prompt,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Audio transcription failed") from exc
