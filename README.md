# EmotionGuard

EmotionGuard는 콜센터 상담사가 고객 음성을 듣기 전에 위험 구간을 실시간으로 보호 처리하는 AI 오디오 게이트웨이입니다. 상담을 대신하는 챗봇이 아니라, 고객 음성이 상담사에게 전달되는 중간 레이어에서 욕설, 성희롱, 고성, 반복 위험 신호를 감지하고 상담사 청취용 오디오와 기록을 보호합니다.

## 핵심 기능

- 고객 음성을 1.8초 지연 버퍼로 전달하며 보호 마스크를 적용
- 비윤리 표현 사전 기반 욕설/성희롱 즉시 감지
- OpenAI STT 단어 타임스탬프 기반 욕설 구간 삐 처리
- RMS 기준 고성 감지 시 출력 시점에 맞춘 변조 및 볼륨 완화
- pitch, peak, ZCR, spectral centroid 등 실시간 음성 메타데이터 추출
- 3초 문맥 스냅샷 기반 폭언/성희롱/협박/반복성 판단
- 감정 음성 데이터셋 기반 로컬 감정 모델과 피드백 루프
- 폭언/고성 4단계, 성희롱 2단계 정책 엔진
- 상담 종료 후 특이민원 보고서 자동 저장
- `/report`에서 누적 보고서와 마스킹된 증빙 타임라인 확인

## 전체 구조

```text
고객 음성 입력
  -> Web Audio API 입력 분석
  -> RMS/peak/pitch/ZCR/centroid 메타데이터 추출
  -> 1.8초 출력 지연 버퍼
  -> 빠른 보호 감지
      - 비윤리 표현 사전
      - STT 단어 타임스탬프
      - 욕설 구간 삐 처리
      - 고성 구간 변조/볼륨 완화
  -> 상담사 청취용 보호 음성 출력

3초 문맥 경로
  -> STT 텍스트 누적
  -> 음성 메타데이터 + 감정 예측 + 세션 피드백 컨텍스트 결합
  -> OpenAI GPT 또는 fallback 문맥 판단
  -> 성희롱, 협박, 반복성, 감정 상태 판단

정책 엔진
  -> 폭언/고성 4단계
  -> 성희롱 2단계
  -> 경고, 단계 상승, 보고서 반영
```

중요한 기준:

- 즉시 마스킹은 사전 감지와 단어 타임스탬프를 우선 사용합니다.
- 감정 예측은 즉시 차단 조건이 아니라 문맥 판단의 참고 신호입니다.
- 고성은 타임라인에 별도 이벤트로 쌓지 않고, 받아쓰기 문장과 오디오 보호 상태에 반영합니다.
- `시발점`, `고양이 새끼`, `기다릴게요`처럼 맥락이 필요한 표현은 단순 사전 차단보다 문맥 판단을 우선합니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| Frontend | React 19, Vite, TypeScript |
| Backend | FastAPI, Pydantic, Uvicorn |
| STT | OpenAI audio transcription with word timestamps |
| 문맥 판단 | OpenAI GPT, fallback rule engine |
| 오디오 처리 | Web Audio API, Jungle Pitch Shifter |
| 감정 분석 | 로컬 감정 모델, 실시간 음성 메타데이터 |
| 보고서 | localStorage 기반 누적 저장, `/report` 분리 화면 |

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

- `/api/transcribe`는 OpenAI API 키가 있어야 동작합니다.
- `/api/analyze`는 OpenAI 키가 없으면 fallback 판단으로 동작합니다.
- `/api/emotion/predict`는 로컬 감정 모델 파일이 있으면 모델을 사용하고, 없으면 acoustic baseline으로 동작합니다.
- `.env`, `.env.local`, 원본 데이터셋, tar 파일은 Git에 커밋하지 않습니다.

### 3. 서버 실행

PowerShell 창을 두 개 열고 각각 실행합니다.

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

기본 주소:

- Frontend: `http://127.0.0.1:4003`
- Backend: `http://127.0.0.1:8000`
- Health check: `http://127.0.0.1:8000/health`
- Reports: `http://127.0.0.1:4003/report`

## 감정 모델 준비

감정 분석은 `small.tar`에서 추출한 `data/skt/` 산출물을 사용합니다. Git에는 실행에 필요한 작은 모델 파일과 샘플 메타데이터만 포함하고, 원본 `small.tar`는 용량이 크기 때문에 커밋하지 않습니다.

권장 위치:

```text
data/skt/small.tar
data/skt/skt_emotion_metadata_sample.csv
data/skt/skt_emotion_model.json
```

빠른 샘플 확인:

```powershell
python scripts\extract_skt_emotion_metadata.py data\skt\small.tar --limit 160 --output data\skt\skt_emotion_metadata_sample.csv
python scripts\train_skt_emotion_model.py data\skt\skt_emotion_metadata_sample.csv --output data\skt\skt_emotion_model.json
```

전체 데이터 처리:

```powershell
python scripts\extract_skt_emotion_metadata.py data\skt\small.tar --output data\skt\skt_emotion_metadata.csv
python scripts\train_skt_emotion_model.py data\skt\skt_emotion_metadata.csv --output data\skt\skt_emotion_model.json
```

주요 추출 컬럼:

- `audio_id`
- `speaker_id`
- `speaker_gender`
- `emotion`
- `emotion_index`
- `service_emotion`
- `duration_s`
- `audio_rms`
- `audio_peak`
- `audio_zero_crossing_rate`
- `spectral_centroid_hz`
- `pitch_hz`
- `pitch_confidence`

## API 요약

### `POST /api/analyze`

발화 텍스트, 고성 여부, 분석 모드, 음성 메타데이터, 피드백 컨텍스트를 받아 이벤트 유형과 정책 액션을 반환합니다.

주요 반환값:

- `eventType`: `normal`, `abuse`, `sexual`, `raised`, `abuse-raised`
- `maskedText`: 민감 구간 마스킹 텍스트
- `policyActions`: `mute`, `pitch_shift`, `volume_reduce`, `warn_tts`, `escalate`, `report`
- `emotionPrediction`: 감정 모델 참고값

### `POST /api/transcribe`

오디오 파일을 받아 STT 텍스트와 단어 타임스탬프를 반환합니다.

```text
multipart/form-data
- file: audio blob
- prompt: optional
```

### `POST /api/emotion/predict`

실시간 음성 feature를 받아 감정 예측값과 판단 근거를 반환합니다.

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
├─ docs/
├─ scripts/
│  ├─ extract_skt_emotion_metadata.py
│  └─ train_skt_emotion_model.py
└─ package.json
```

## 현재 상태

- React/Vite 프론트엔드와 FastAPI 백엔드를 분리했습니다.
- 프론트엔드는 4003, 백엔드는 8000 포트를 기본으로 사용합니다.
- OpenAI STT 단어 타임스탬프 기반 삐 처리를 연결했습니다.
- 고성은 타임라인 소음 없이 오디오 보호 상태에만 반영합니다.
- 문맥 판단은 OpenAI GPT와 fallback 경로를 사용합니다.
- 보고서는 `/report` 화면으로 분리했습니다.
- 반복 로그가 중복으로 쌓이는 문제를 완화했습니다.
- 감정 예측은 문맥 판단 참고 정보로 전달됩니다.

## 남은 검증

- 실제 상담 환경에서 STT 지연, 오탐, 마스킹 타이밍 검증
- 고성 변조 체감 품질 조정
- 전체 감정 데이터셋 기반 모델 재학습
- 문맥 판단 결과에 대한 XAI 설명 형식 고도화
