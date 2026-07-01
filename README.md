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

EmotionGuard는 프론트엔드와 백엔드를 분리한 구조로 개발합니다.

```text
frontend/
  Web Speech API       실시간 STT
  Web Audio API        고성 감지, 피치 시프팅, 묵음 처리
  상담사 대시보드       단계별 경고, 로그, 음량 시각화

backend/
  FastAPI              분석 API 서버
  Local Dictionary     욕설/성희롱 사전 및 예외어 기반 즉시 판정
  Claude Analyzer      애매한 발화의 문맥 판단
  Policy API           분석 결과, 마스킹 텍스트, 이벤트 타입 반환
```

브라우저에는 상담 화면, 마이크 제어, 음성 출력 보호 로직만 둡니다. Claude API 키와 민감한 판정 프롬프트는 백엔드에서만 관리해 클라이언트에 노출하지 않습니다.

## Project Structure

```text
.
├── backend
│   ├── app
│   │   ├── data/dictionaries.json
│   │   ├── routers/analyze.py
│   │   ├── services/claude.py
│   │   └── services/local_classifier.py
│   └── .env.example
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

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- Health Check: `http://localhost:4000/health`

## API

### `POST /api/analyze`

발화 텍스트와 고성 여부를 받아 로컬 사전 또는 Claude API로 위험 발화를 판정합니다.

```json
{
  "text": "분석할 발화",
  "raised": false
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
  "triggeredWords": ["시발"],
  "raised": false,
  "eventType": "abuse",
  "maskedText": "**"
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
- [ ] 특이 민원 보고서 자동 생성 기능 구현
- [ ] 상담 세션 로그 저장소 연동
- [ ] PIP 상담 보조창 재구현
- [ ] 상담사 보호 대시보드 고도화

## Team

EMOTION GUARD 프로젝트 팀
