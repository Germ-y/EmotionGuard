# EmotionGuard

감정노동자 보호를 위한 실시간 AI 음성 보호 솔루션입니다.

EmotionGuard는 상담 대화를 대신하는 챗봇이 아니라, 고객 음성이 상담사에게 전달되기 전 보호 처리하는 중간 오디오 게이트웨이입니다. 비윤리 표현은 빠르게 감지해 삐 처리하고, 고성은 청취 부담을 낮추며, 성희롱이나 협박처럼 문맥이 필요한 발화는 STT와 3초 문맥 판단으로 보조 분석합니다.

## 핵심 기능

- 고객 음성을 약 1.8초 버퍼링한 뒤 상담사 청취용 보호 음성으로 출력
- 비윤리 표현 사전 기반 욕설 구간 삐 처리
- OpenAI STT 단어 타임스탬프 기반 마스킹 위치 계산
- RMS, peak, pitch, ZCR, spectral centroid 기반 음향 메타데이터 추출
- 고성 감지 시 볼륨 및 피치 완화
- OpenAI GPT 기반 3초 문맥 판단
- 폭언/고성 4단계, 성희롱 2단계 정책 엔진
- 상담 종료 시 특이민원 보고서 자동 저장
- `/report` 화면에서 보고서 타임라인 확인
- SKT 감정 음성 데이터셋 기반 음성 감정 분류 모델
- 감정 예측값과 피드백 루프를 문맥 판단 참고 정보로 전달

## 현재 판단 구조

```text
고객 음성 입력
  -> Web Audio API 입력 분석
  -> 20ms 오디오 프레임 / 지연 출력 버퍼
  -> 빠른 보호 경로
      - RMS 고성 분석
      - 비윤리 표현 사전 감지
      - STT 단어 타임스탬프
      - 욕설 단어 구간 삐 처리
  -> 상담사 청취용 보호 음성 출력

3초 문맥 경로
  -> STT 누적 텍스트
  -> 음향 메타데이터
  -> SKT 감정 모델 예측값
  -> 이전 발화 피드백 컨텍스트
  -> GPT/fallback 문맥 판단
  -> 성희롱, 협박, 반복성, 감정 상태 판단

정책 엔진
  -> 폭언/고성 4단계
  -> 성희롱 2단계
  -> 경고, 단계 상승, 보고서 반영
```

중요한 기준:

- 비윤리 표현 사전은 즉시 마스킹에 사용합니다.
- SKT 감정 모델 예측값은 즉시 마스킹 조건으로 사용하지 않습니다.
- 감정 모델 결과는 문맥 판단에 `emotionPrediction`으로 넘기는 참고 신호입니다.
- 높은 피치, 큰 음량, 빠른 말속도만으로 욕설이나 성희롱을 확정하지 않습니다.
- “기다릴게요” 같은 일반 표현은 사전에 직접 넣지 않고 문맥 판단으로만 처리합니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| Frontend | React 19, Vite, TypeScript |
| Backend | FastAPI, Pydantic, Uvicorn |
| STT | OpenAI audio transcription, word timestamp |
| 문맥 판단 | OpenAI GPT, fallback 보수 판단 |
| 오디오 처리 | Web Audio API, Jungle Pitch Shifter |
| 감정 모델 | SKT 감정 음성 데이터셋 메타데이터 + centroid 모델 |
| 보고서 | localStorage 기반 누적 저장, `/report` 분리 화면 |

Claude API는 사용하지 않습니다.

## 실행 방법

### 1. 의존성 설치

```powershell
cd C:\Users\yungg\Downloads\EmotionGuard
npm install --prefix frontend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env
```

### 2. 환경 변수 설정

`backend/.env`에 API 키와 모델 경로를 설정합니다.

```env
PORT=8000
CORS_ORIGIN=http://localhost:4003,http://127.0.0.1:4003
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
EMOTION_MODEL_PATH=data/skt/skt_emotion_model.json
```

주의:

- `/api/transcribe`는 OpenAI API 키가 필요합니다.
- `/api/analyze`는 OpenAI 키가 없으면 fallback 판단으로 동작합니다.
- `/api/emotion/predict`는 로컬 `data/skt/skt_emotion_model.json`이 있으면 SKT centroid 모델을 사용하고, 없으면 acoustic baseline으로 동작합니다.

### 3. 서버 실행

PowerShell 창을 두 개 열어 각각 실행합니다.

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

기본 주소:

- Frontend: `http://127.0.0.1:4003`
- Backend: `http://127.0.0.1:8000`
- Health Check: `http://127.0.0.1:8000/health`

## SKT 감정 모델 준비

`small.tar`는 원본 대용량 데이터라 git에 커밋하지 않습니다. 현재 extractor는 `small.tar` 내부의 중첩 tar를 스트리밍으로 읽고, 파일명 발화 번호를 기준으로 감정 인덱스를 붙입니다.

감정 인덱스 기준:

| 인덱스 | 발화 번호 | 원 감정 | 서비스 감정 |
| --- | --- | --- | --- |
| 1 | 1-20 | neutral | normal |
| 2 | 21-30 | angry | angry |
| 3 | 31-40 | joy | normal |
| 4 | 41-50 | sad | frustrated |
| 5 | 51-60 | serious | frustrated |
| 6 | 61-70 | anxious | frustrated |
| 7 | 71-80 | kind | normal |
| 8 | 81-90 | dry | normal |
| 9 | 91-100 | tease | angry |
| 10 | 101-110 | doubt | normal |
| 11 | 111-120 | surprise | frustrated |
| 12 | 121-130 | shy | normal |
| 13 | 131-140 | hurry | frustrated |
| 14 | 141-150 | fear | frustrated |
| 15 | 151-160 | hesitate | normal |

빠른 샘플 확인:

```powershell
python scripts\extract_skt_emotion_metadata.py .\small.tar --limit 160 --output data\skt\skt_emotion_metadata_sample.csv
python scripts\train_skt_emotion_model.py data\skt\skt_emotion_metadata_sample.csv --output data\skt\skt_emotion_model.json
```

전체 데이터 처리:

```powershell
python scripts\extract_skt_emotion_metadata.py .\small.tar --output data\skt\skt_emotion_metadata.csv
python scripts\train_skt_emotion_model.py data\skt\skt_emotion_metadata.csv --output data\skt\skt_emotion_model.json
```

생성되는 주요 컬럼:

- `audio_id`
- `audio_path`
- `speaker_id`
- `speaker_gender`
- `emotion`
- `emotion_index`
- `emotion_detail`
- `service_emotion`
- `duration_s`
- `audio_rms`
- `audio_peak`
- `audio_zero_crossing_rate`
- `spectral_centroid_hz`
- `pitch_hz`
- `pitch_confidence`

샘플 160개 기준 라벨 분포:

- `normal`: 80
- `frustrated`: 60
- `angry`: 20

## API 요약

### `POST /api/analyze`

발화 텍스트, 고성 여부, 분석 모드, 음향 메타데이터, 피드백 컨텍스트를 받아 정책 결과를 반환합니다.

`context_snapshot` 또는 애매한 즉시 판단 경로에서는 `emotionPrediction`이 문맥 판단 payload에 함께 전달됩니다.

### `POST /api/emotion/predict`

실시간 음향 feature를 받아 감정 예측값을 반환합니다.

```json
{
  "audioFeatures": {
    "rmsPercent": 34,
    "peak": 0.22,
    "pitchHz": 174,
    "zeroCrossingRate": 0.08,
    "spectralCentroidHz": 1900,
    "voiceActivity": true
  }
}
```

응답 예시:

```json
{
  "label": "frustrated",
  "confidence": 0.52,
  "source": "skt_centroid_model",
  "scores": {
    "normal": 0.31,
    "frustrated": 0.52,
    "angry": 0.17
  },
  "reasons": ["라벨 기반 centroid 모델", "실시간 음향 특징 매칭"]
}
```

### `POST /api/transcribe`

오디오 파일을 받아 STT 텍스트와 단어 타임스탬프를 반환합니다.

```text
multipart/form-data
- file: audio blob
- prompt: optional
```

## 프로젝트 구조

```text
.
├─ backend/
│  ├─ app/
│  │  ├─ routers/
│  │  │  ├─ analyze.py
│  │  │  ├─ emotion.py
│  │  │  └─ transcribe.py
│  │  ├─ services/
│  │  │  ├─ analysis_prompt.py
│  │  │  ├─ context_engine.py
│  │  │  ├─ emotion_model.py
│  │  │  ├─ local_classifier.py
│  │  │  ├─ openai.py
│  │  │  └─ policy_engine.py
│  │  └─ data/
│  └─ requirements.txt
├─ frontend/
│  ├─ public/demo-audio/
│  └─ src/
│     ├─ App.tsx
│     ├─ lib/api.ts
│     └─ lib/audio/jungle.ts
├─ scripts/
│  ├─ extract_skt_emotion_metadata.py
│  └─ train_skt_emotion_model.py
└─ package.json
```

## 현재 상태

- React/Vite 프론트엔드와 FastAPI 백엔드를 분리했습니다.
- OpenAI STT 단어 타임스탬프 기반 삐 처리를 연결했습니다.
- GPT 기반 3초 문맥 판단과 fallback 경로를 연결했습니다.
- 보고서 화면을 `/report`로 분리했습니다.
- 반복 로그가 쌓이는 문제를 완화했습니다.
- SKT `small.tar`에서 감정 라벨 메타데이터를 추출하고 centroid 모델을 생성합니다.
- 실시간 음향 feature를 `/api/emotion/predict`로 보내 감정 예측을 표시합니다.
- 감정 예측은 즉시 마스킹이 아니라 문맥 판단 참고 정보로만 사용합니다.

## 남은 검증

- 전체 `small.tar` 메타데이터 추출 및 전체 모델 재학습
- 실제 상담 환경에서 STT 지연, 삐 타이밍, 청취 모니터링 검증
- 성희롱 문맥 판단에서 감정 예측값이 과잉 반영되지 않는지 테스트
- XAI 형식의 판단 근거 표시 고도화
