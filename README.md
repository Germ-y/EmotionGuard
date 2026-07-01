# EMOTION GUARD

> 감정노동자 보호를 위한 실시간 AI 음성 보호 솔루션

EMOTION GUARD(이모션 가드)는 콜센터 상담사가 통화 중 마주하는 욕설, 고성, 성희롱 발언을 실시간으로 감지하고 완화하는 AI 기반 음성 보호 솔루션입니다. 기존 악성 민원 대응이 사후 경고와 녹취 재검토에 머물렀다면, EMOTION GUARD는 상담사가 폭언에 직접 노출되는 순간부터 음성 필터링, 위험 경고, 증빙 확보, 보고서 생성을 자동화합니다.

## Background

감정노동자는 고객 응대 과정에서 반복적인 언어폭력과 인격 무시에 노출됩니다. 우리나라 취업자 약 2,680만 명 중 감정노동 종사자는 약 1,175만 명으로 전체의 약 43.8%에 달하며, 이들 중 87.7%가 인격 무시를, 81.4%가 욕설·폭언을 경험했습니다.

감정노동자의 우울증 유병률은 일반인의 약 7배(6%에서 44.1%)이고, 자살 고위험군 비율도 18.2%에 이릅니다. 그러나 기존 대응 매뉴얼은 폭언이나 성희롱이 발생한 뒤 경고하거나 상담 종료를 안내하는 방식에 가깝습니다. 이 과정에서 상담사는 이미 폭력에 노출되며, 사후 검토를 위해 녹취를 다시 듣는 과정에서 2차 피해와 행정 부담이 발생합니다.

## Solution

EMOTION GUARD는 통화가 진행되는 동안 음성 입력을 실시간으로 분석해 위험 발화를 감지하고, 상담사에게 전달되기 전 보호 처리를 수행합니다.

| 구분 | 기능 | 설명 |
| --- | --- | --- |
| 욕설 차단 | 실시간 비프음 처리 | 로컬 욕설 사전과 공개 욕설 감지 데이터셋을 활용해 욕설을 빠르게 감지하고 비프음으로 대체합니다. |
| 고성 완화 | 음정 변환 | 기준 데시벨(dB)을 초과하는 고성을 감지하면 Web Audio API 기반 피치 시프터로 음정을 완화합니다. |
| 성희롱 대응 | 감지·경고·증빙 확보 | 성희롱 표현을 즉시 탐지하고 상담사에게 경고하며 사후 증빙 자료를 확보합니다. |
| 사후 처리 | 보고서 자동 생성 | 상담 종료 후 특이 민원 발생 보고서를 원클릭으로 생성해 행정 부담을 줄입니다. |

## Key Features

- 실시간 욕설 감지 및 비프음 대체
- 고성·고압적 음성의 음정 완화
- 성희롱 발언 감지, 경고, 증빙 확보
- 상담 종료 후 특이 민원 보고서 자동 생성
- 음량 변화 시각화 및 단계별 경고
- 로컬 사전 기반 즉시 차단과 Claude API 기반 맥락 판단을 결합한 하이브리드 탐지

## AI & Technology

| 영역 | 활용 도구 |
| --- | --- |
| 맥락 판단 | Claude API |
| 즉시 차단 | 로컬 욕설 사전 약 200개, 성희롱 사전 약 280개 |
| 학습·탐지 보조 | 공개 욕설 감지 데이터셋 |
| 음성 처리 | Web Audio API, Jungle Pitch Shifter |
| 업무 자동화 | 보고서 자동 생성, 음량 시각화, 단계별 경고 모듈 |

## Architecture

EmotionGuard는 프론트엔드와 백엔드를 분리하되, 실시간 보호 경로와 3초 AI 문맥 판단 경로를 병렬로 운용합니다.

```text
내담자 음성 입력
  -> 20ms Audio Frame
  -> Ring Buffer
  -> Streaming Audio Guard
  -> 출력 커서에서 보호 마스크 적용
  -> 보호된 상담사 청취 음성

즉시 감지 경로
  -> RMS 고성 분석
  -> STT 인터림
  -> 로컬 욕설/성희롱 사전
  -> 즉시 위험 이벤트

3초 문맥 판단 경로
  -> STT 스트림 스냅샷
  -> Claude 문맥 분석
  -> 성희롱/협박/반복성/감정 상태 판단

Policy Engine
  -> 폭언/고성 4단계
  -> 성희롱 2단계
  -> TTS 오탐 차단
  -> 중복 감지 방지
  -> 욕설 구간 비프음, 피치/볼륨 완화, 경고, 보고서 액션 결정
```

브라우저에는 상담 화면, 마이크 제어, 출력 보호 마스크, 대시보드 표시만 둡니다. 로컬 사전과 Claude API 키, 문맥 판단 프롬프트는 FastAPI 백엔드에서 관리합니다. 상세 기준은 [docs/architecture.md](docs/architecture.md)에 정리되어 있습니다.

## Project Structure

```text
.
├── backend
│   ├── app
│   │   ├── data/dictionaries.json
│   │   ├── routers/analyze.py
│   │   └── services
│   │       ├── claude.py
│   │       ├── local_classifier.py
│   │       └── policy_engine.py
│   └── .env.example
├── docs
│   └── architecture.md
├── frontend
│   └── src
│       ├── App.tsx
│       ├── lib/api.ts
│       └── lib/audio/jungle.ts
└── package.json
```

## Getting Started

```bash
npm install
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

`backend/.env`에 Claude API 키를 설정합니다.

```env
ANTHROPIC_API_KEY=sk-ant-...
```

백엔드와 프론트엔드를 각각 실행합니다.

```bash
npm run dev:backend
npm run dev:frontend
```

기본 실행 주소는 다음과 같습니다.

- Frontend: `http://127.0.0.1:4003`
- Backend: `http://localhost:8000`
- Health Check: `http://localhost:8000/health`

프론트엔드 dev 서버는 발표 환경에서 포트가 바뀌지 않도록 `4003`에 고정되어 있습니다. 백엔드는 `localhost:4003`과 `127.0.0.1:4003`을 모두 CORS 허용합니다.

## Demo Mode

실제 통화에서는 즉시 보호 경로와 3초 문맥 판단 경로가 병렬로 동작합니다. 다만 발표 데모에서는 동시성을 그대로 보여주기 어렵기 때문에, 프론트엔드에 단계형 데모 버튼을 제공합니다.

- 상담 시작 후 발화하면 화면의 `즉시 마스킹 처리` 카드가 STT 인터림과 로컬 사전 판단 결과를 바로 표시합니다.
- 같은 발화는 3초 단위로 모여 `3초 맥락 처리` 카드에 표시되고, Claude 문맥 판단 결과가 경고·에스컬레이션·보고서 액션으로 이어집니다.
- 상단 과정 표시등은 `음성 입력 → 빠른 감지 → 보호 마스크 → 3초 맥락 → 정책 엔진` 순서로 현재 처리 단계를 점등합니다.
- 폭언/고성 4단계와 성희롱 2단계 표시등은 위험 이벤트가 단계에 진입할 때 켜집니다.
- 상담 종료 또는 데모 종료 시 세션 로그 기반 `특이민원 보고서`가 자동 생성되고, 증빙 발화와 후속 권고를 복사할 수 있습니다.
- `욕설 삐 처리`: 로컬 욕설 사전 감지 → timestamp 기반 욕설 단어 구간 비프음 → 로그/보고서 액션
- `고성 완화`: RMS 고성 분석 → 피치/볼륨 완화 → 단계 상승
- `성희롱 경고`: 로컬 성희롱 감지 → 경고 TTS → 3초 문맥 판단 → 보고서 액션
- `4단계 상승`: 반복 폭언 이벤트 → 1단계부터 4단계까지 단계 표시등 순차 점등

마이크 권한을 쓰기 어려운 발표 환경에서는 데모 버튼만 눌러도 동일한 카드가 순서대로 갱신됩니다. 실제 아키텍처는 유지하면서 발표자가 설명하기 쉬운 순서로 상태를 시각화합니다.

## API

### `POST /api/analyze`

발화 텍스트, 고성 여부, 분석 경로를 받아 위험 발화를 판정합니다.

```json
{
  "text": "분석할 발화",
  "raised": false,
  "analysisMode": "immediate",
  "contextWindowMs": 3000
}
```

`analysisMode`는 두 가지입니다.

- `immediate`: 로컬 사전과 고성 여부를 사용해 즉시 욕설 구간 비프음/피치/볼륨 마스크에 쓰는 경로
- `context_snapshot`: 3초 단위 STT 스냅샷을 Claude로 분석해 경고, 에스컬레이션, 보고서에 쓰는 경로

응답 예시:

```json
{
  "abusive": true,
  "severity": "severe",
  "categories": ["욕설"],
  "emotion": "angry",
  "sexual": false,
  "source": "local",
  "triggeredWords": ["시발"],
  "raised": false,
  "eventType": "abuse",
  "maskedText": "**",
  "detectionPath": "immediate",
  "contextWindowMs": 3000,
  "policyActions": ["mute", "warn_tts", "escalate", "report"]
}
```

## Target Users

1차 적용 대상은 서울특별시 120다산콜재단(다산콜센터)입니다.

이후 다음 영역으로 확장할 수 있습니다.

- 공공기관 콜센터
- 민간 고객센터
- 행정 민원 응대 기관
- 교육·의료 분야 음성 응대 기관
- 감정노동 보호가 필요한 실시간 상담 조직

## Expected Impact

- 상담사의 욕설·성희롱 직접 노출 감소
- 녹취 재검토 과정에서 발생하는 2차 피해 완화
- 특이 민원 보고서 작성 시간 단축
- 악성 민원 대응 기준의 일관성 확보
- 사후 대응 중심 매뉴얼을 실시간 보호 중심 시스템으로 전환

## Project Status

현재 저장소에는 단일 HTML 프로토타입을 참고해 프론트엔드와 백엔드를 분리한 초기 구현이 들어 있습니다. 프론트엔드는 실시간 상담 화면과 브라우저 음성 처리를 담당하고, 백엔드는 로컬 사전 판정과 Claude API 기반 문맥 분석을 담당합니다.

## Roadmap

- [x] 프론트엔드/백엔드 프로젝트 구조 분리
- [x] 욕설·성희롱 로컬 사전 백엔드 모듈화
- [x] Claude API 기반 맥락 판단 API 구성
- [x] 고성 감지 및 피치 시프팅 프론트엔드 모듈 구성
- [x] 즉시 감지 경로와 3초 문맥 판단 경로 분리
- [x] 정책 엔진 액션 응답 구조 구성
- [x] 특이 민원 보고서 자동 생성 기능 구현
- [ ] 상담 세션 로그 저장소 연동
- [ ] PIP 상담 보조창 재구현
- [ ] 상담사 보호 대시보드 고도화

## Team

EMOTION GUARD 프로젝트 팀
