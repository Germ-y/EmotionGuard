# EmotionGuard Architecture

## 1. 전체 아키텍처 구조

### 실시간 상담 대화

- 내담자와 상담사는 기본 대화 흐름을 유지한다.
- EmotionGuard는 대화를 대신하는 AI가 아니라, 내담자 음성이 상담사에게 전달되기 전 보호 처리하는 중간 레이어다.

### 오디오 게이트웨이

- 내담자 음성 입력을 받는다.
- `Streaming Audio Guard`가 상담사 청취용 음성을 보호 처리한다.
- 상담사 발화는 지연 없이 내담자에게 전달된다.

### 빠른 보호 감지 레이어

- RMS 고성 분석
- 로컬 욕설 사전 감지
- 로컬 성희롱 표현 감지
- 즉시 위험 이벤트 생성

### AI 문맥 판단 레이어

- STT 스트림 생성
- 3초 단위 문맥 스냅샷 구성
- 맥락 엔진이 성희롱, 협박, 반복성, 감정 상태를 판단
- `ANTHROPIC_API_KEY`가 있으면 Claude API를 호출하고, 키가 없으면 fallback 보수 판단을 사용
- 느린 판단은 즉시 비프음 처리보다는 경고, 에스컬레이션, 보고서에 사용

### 정책 엔진

- 폭언/고성 4단계 에스컬레이션
- 성희롱 2단계 에스컬레이션
- TTS 중 오탐 차단
- 중복 감지 방지
- 보호 마스크와 경고 액션 결정

### 개입 및 기록 레이어

- timestamp 기반 욕설 단어 구간 비프음 처리
- 고성 구간 피치/볼륨 완화
- 자동 경고 TTS
- PIP/메인 대시보드 표시
- 로그 및 특이민원 보고서 생성

## 2. 실시간성 처리 구조

1. 고객 음성 입력은 계속 들어온다.
2. 입력은 20ms 오디오 프레임 단위로 Ring Buffer에 쌓인다.
3. 즉시 감지 경로가 RMS, STT 인터림, 로컬 사전을 빠르게 확인한다.
4. 위험 이벤트가 생기면 욕설 구간 비프음/피치/볼륨 마스크를 만든다.
5. 출력 커서는 약간 뒤에서 따라가며 마스크를 적용한 뒤 상담사에게 보호된 음성을 들려준다.
6. 3초 스냅샷 경로는 별도로 돌아가며 맥락 엔진 판단을 수행한다.
7. Policy Engine은 즉시 위험 이벤트와 문맥 판단을 합쳐 경고, 보고서, 단계 상승을 결정한다.

## 3. 현재 구현 매핑

| 아키텍처 요소 | 현재 구현 |
| --- | --- |
| 오디오 게이트웨이 | `frontend/src/App.tsx`의 Web Audio graph |
| 피치/볼륨 완화 | `frontend/src/lib/audio/jungle.ts` |
| 출력 커서 | `AudioContext.createDelay()` 기반 지연 출력 |
| STT 스트림 | Web Speech API |
| 3초 문맥 스냅샷 | `context_snapshot` 분석 모드 |
| 로컬 사전 감지 | `backend/app/data/dictionaries.json`, `local_classifier.py` |
| 맥락 엔진 판단 | `backend/app/services/claude.py` (`source=claude` 또는 `source=fallback`) |
| 정책 엔진 | `backend/app/services/policy_engine.py` 및 프론트 단계 카운터 |
| 로그/대시보드 | React 상담사 대시보드 |
