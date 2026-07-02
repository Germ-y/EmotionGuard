from fastapi import APIRouter, HTTPException

from app.models import EmotionPredictRequest, EmotionPredictResponse
from app.services.emotion_model import predict_emotion


router = APIRouter(prefix="/api/emotion", tags=["emotion"])


@router.post("/predict", response_model=EmotionPredictResponse)
async def predict(payload: EmotionPredictRequest) -> EmotionPredictResponse:
    prediction = predict_emotion(payload.audioFeatures)
    if prediction is None:
        raise HTTPException(status_code=400, detail="audioFeatures are required")
    return EmotionPredictResponse(**prediction.model_dump(), audioFeatures=payload.audioFeatures)
