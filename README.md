# EmotionGuard

감정노동자 보호를 위한 실시간 AI 음성 보호 솔루션

EmotionGuard는 콜센터 상담사가 악성 민원 발화에 직접 노출되기 전에 고객 음성을 중간 레이어에서 보호 처리하는 시스템이다. 상담을 대신하는 챗봇이 아니라, 고객 음성이 상담사에게 전달되기 전 욕설 구간 삐 처리, 고성 완화, 성희롱/협박 문맥 판단, 경고/보고서 생성을 수행하는 오디오 보호 게이트웨이다.

현재 브랜치 `feat/emotion-analysis-feedback-loop`에는 기본 시연 기능에 더해 감정/음향 메타데이터 기반 피드백 루프와 SKT 음성 감정 데이터셋 연동 준비 코드가 포함되어 있다.

## 핵심 기능

- 실시간 고객 음성 입력 수신 및 상담사 청취용 보호 출력
- 비윤리 표현 사전 기반 욕설/성희롱 즉시 감지
- OpenAI Whisper STT 기반 짧은 청크 받아쓰기 및 단어 타임스탬프 활용
- 욕설 단어 구간만 삐 처리하고 나머지 문장은 유지
- RMS, pitch, peak, ZCR, spectral centroid 기반 고성/감정 보조 메타데이터 추출
- OpenAI GPT 또는 Claude 기반 3초 문맥 판단
- 폭언/고성 4단계, 성희롱 2단계 정책 엔진
- 상담 종료 시 특이민원 보고서 자동 저장 및 `/report` 화면 분리
- 대화 중 누적 위험 신호를 다음 판단 입력에 반영하는 피드백 루프
- mp3 기반 데모 리모콘: 욕설 삐 처리, 성희롱 경고

## 아키텍처

```text
고객 음성 입력
  -> 오디오 게이트웨이
  -> 20ms 오디오 프레임 / Ring Buffer
  -> 빠른 보호 감지
      - RMS 고성 분석
      - 비윤리 표현 사전 감지
      - STT 청크 단어 타임스탬프
  -> 보호 마스크
      - 욕설 구간 삐 처리
      - 고성 피치/볼륨 완화
  -> 상담사 청취 출력

3초 문맥 경로
  -> STT 스냅샷
  -> 음향 메타데이터 결합
  -> GPT/Claude/fallback 문맥 판단
  -> 성희롱, 협박, 반복성, 감정 상태 판단

피드백 루프
  -> 이전 발화의 이벤트/감정/음향 추세 누적
  -> feedbackContext 생성
  -> 다음 /api/analyze 입력에 약한 prior로 반영
```

피드백 루프는 단독으로 욕설이나 성희롱을 확정하지 않는다. 반복 위험, 감정 상승, 애매한 성희롱 단서가 있을 때 문맥 엔진을 더 적극적으로 호출하고 판단 보조 근거로만 사용한다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| Frontend | React 19, Vite, TypeScript |
| Backend | FastAPI, Pydantic, Uvicorn |
| STT | OpenAI audio transcription, word timestamp |
| 문맥 판단 | OpenAI GPT 우선, Claude 대체, fallback 보수 판단 |
| 오디오 처리 | Web Audio API, Jungle Pitch Shifter |
| 데이터 준비 | AI-Hub 비윤리 표현 사전, KEMDy20/SKT 음성 감정 메타데이터 추출 스크립트 |

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

`backend/.env`에 필요한 API 키를 넣는다. 실제 키는 커밋하지 않는다.

```env
PORT=8000
CORS_ORIGIN=http://localhost:4003,http://127.0.0.1:4003
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

주의:

- `/api/transcribe`는 OpenAI API 키가 없으면 502를 반환한다.
- `/api/analyze`는 OpenAI/Claude 키가 없어도 fallback 판단으로 동작한다.
- OpenAI와 Claude 키가 모두 있으면 현재 코드는 OpenAI를 우선 사용한다.

### 3. 서버 실행

PowerShell 창을 두 개 열어 각각 실행한다.

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

## 데모 흐름

1. 백엔드와 프론트엔드를 실행한다.
2. 브라우저에서 `http://127.0.0.1:4003` 접속한다.
3. `상담 시작`을 누르고 마이크 권한을 허용한다.
4. 실제 음성 입력이 들어오면 받아쓰기, 보호 상태, 타임라인이 갱신된다.
5. 오른쪽 데모 리모콘에서 mp3 기반 시나리오를 실행할 수 있다.
6. 상담 종료 시 보고서가 자동 생성되고 `/report`에서 누적 보고서를 확인한다.

현재 데모 리모콘에 남긴 버튼:

- `욕설 삐 처리`: mp3 발화를 STT로 분석하고 욕설 단어 구간만 삐 처리
- `성희롱 경고`: mp3 발화를 문맥 판단과 정책 엔진으로 처리

## 주요 화면

- 메인 상담 화면: 실시간 타이머, 단계 그래프, RMS, 음향 메타데이터, 상담 타임라인
- 감지 현황 패널: 욕설, 욕설+고성, 고성, 성희롱 카운터
- 피드백 루프 카드: 위험 점수, 반복 신호, 음향 추세 표시
- 보고서 화면 `/report`: 상담 종료 후 생성된 특이민원 보고서 목록

## API

### `POST /api/analyze`

발화 텍스트, 고성 여부, 분석 모드, 음향 메타데이터, 피드백 컨텍스트를 받아 정책 결과를 반환한다.

```json
{
  "text": "분석할 발화",
  "raised": false,
  "analysisMode": "immediate",
  "contextWindowMs": 3000,
  "audioFeatures": {
    "rmsPercent": 34,
    "peak": 0.22,
    "pitchHz": 174,
    "zeroCrossingRate": 0.08,
    "spectralCentroidHz": 1900,
    "voiceActivity": true
  },
  "feedbackContext": {
    "sessionRiskScore": 38,
    "repeatedRisk": false,
    "abuseCount": 1,
    "sexualCount": 0,
    "raisedCount": 0,
    "normalCount": 3,
    "recentEvents": ["normal", "abuse"],
    "recentEmotions": ["normal", "angry"],
    "recentCategories": ["욕설"],
    "recentTriggeredWords": [],
    "lastEventType": "abuse",
    "lastEmotion": "angry",
    "acousticTrend": "stable",
    "notes": []
  }
}
```

응답 예시:

```json
{
  "abusive": true,
  "severity": "severe",
  "categories": ["욕설"],
  "emotion": "angry",
  "sexual": false,
  "source": "local",
  "triggeredWords": ["욕설단어"],
  "raised": false,
  "eventType": "abuse",
  "maskedText": "***",
  "detectionPath": "immediate",
  "contextWindowMs": 3000,
  "policyActions": ["mute", "warn_tts", "escalate", "report"]
}
```

### `POST /api/transcribe`

오디오 파일을 받아 OpenAI STT 결과와 단어 타임스탬프를 반환한다.

```text
multipart/form-data
- file: audio blob
- prompt: optional
```

## 데이터셋 준비

### AI-Hub 비윤리 표현 사전

AI-Hub 텍스트 윤리검증 데이터셋에서 욕설/성희롱 후보를 추출해 백엔드 사전에 병합할 수 있다.

```powershell
python scripts\extract_aihub_ethics_dictionary.py download.tar
```

생성 파일:

```text
backend/app/data/dictionaries.aihub.json
```

이 파일은 `.gitignore` 대상이다.

### KEMDy20 감정 메타데이터

```powershell
python scripts\extract_kemdy20_metadata.py KEMDy20_v1_3.zip
```

기본 출력:

```text
data/kemdy20/kemdy20_metadata.csv
```

### SKT 음성 감정 데이터

현재 `SKT데이터/`는 원본 대용량 데이터 보관 위치이며 `.gitignore` 대상이다. small 데이터가 완성본으로 들어오면 압축을 푼 뒤 아래 명령으로 감정 분석용 CSV를 만든다.

```powershell
python scripts\extract_skt_emotion_metadata.py .\SKT데이터\extracted --output data\skt\skt_emotion_metadata.csv
```

현재 스크립트가 추출하는 주요 컬럼:

- `audio_id`
- `audio_path`
- `emotion`
- `transcript`
- `duration_s`
- `audio_rms`
- `audio_peak`
- `audio_zero_crossing_rate`
- `spectral_centroid_hz`
- `pitch_hz`
- `pitch_confidence`

## 프로젝트 구조

```text
.
├─ backend/
│  ├─ app/
│  │  ├─ routers/
│  │  │  ├─ analyze.py
│  │  │  └─ transcribe.py
│  │  ├─ services/
│  │  │  ├─ local_classifier.py
│  │  │  ├─ context_engine.py
│  │  │  ├─ openai.py
│  │  │  ├─ claude.py
│  │  │  └─ policy_engine.py
│  │  └─ data/
│  │     └─ dictionaries.json
│  └─ requirements.txt
├─ frontend/
│  └─ src/
│     ├─ App.tsx
│     ├─ lib/api.ts
│     └─ lib/audio/jungle.ts
├─ docs/
├─ scripts/
└─ package.json
```

## 판단 기준 요약

- 비윤리 표현 사전에 명확히 걸리는 욕설/성희롱은 즉시 보호 경로에서 처리한다.
- `시발점`, `시발역`, `시발지`처럼 오탐 가능성이 큰 표현은 예외 처리한다.
- 애매한 표현은 3초 문맥 판단으로 넘긴다.
- 음향 메타데이터는 감정/긴장도 보조 근거로만 사용하며, 단독으로 성희롱이나 폭언을 확정하지 않는다.
- 피드백 루프도 약한 prior로만 사용한다. 현재 발화나 문맥 증거가 없는 경우에는 위험 판정을 만들지 않는다.

## 현재 상태

- 기본 시연 기능은 동작한다.
- 실시간 단어 단위 삐 처리는 OpenAI STT 단어 타임스탬프 품질에 영향을 받는다.
- 브라우저 Web Speech와 OpenAI 청크 STT를 함께 사용하므로 환경에 따라 받아쓰기 품질이 달라질 수 있다.
- SKT 데이터셋 기반 감정 모델링은 아직 준비 단계다. 현재는 메타데이터 추출 스크립트와 피드백 루프 입력 계약까지 구현되어 있다.

## 로드맵

- [x] React/Vite 프론트엔드와 FastAPI 백엔드 분리
- [x] 비윤리 표현 사전 기반 즉시 감지
- [x] OpenAI STT 단어 타임스탬프 기반 삐 처리
- [x] 3초 문맥 판단 경로
- [x] 보고서 화면 `/report` 분리
- [x] 피드백 루프 입력 계약 및 UI 표시
- [x] SKT 감정 데이터셋 메타데이터 추출 준비
- [ ] small SKT 데이터 압축 해제 후 실제 메타데이터 CSV 생성
- [ ] 감정 분류 모델 학습 및 백엔드 추론 API 연결
- [ ] 실제 콜센터 오디오 게이트웨이 연동 검증
