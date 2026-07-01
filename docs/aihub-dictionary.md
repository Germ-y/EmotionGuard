# AI-Hub 사전 확장 파이프라인

EmotionGuard는 기본 비윤리 표현 사전인 `backend/app/data/dictionaries.json`을 우선 사용한다. AI-Hub 텍스트 윤리검증 데이터는 원본을 그대로 커밋하지 않고, 개발 환경에서 `backend/app/data/dictionaries.aihub.json` 확장 사전으로 변환한 뒤 런타임에 자동 병합한다.

## 사용 의도

AI-Hub 텍스트 윤리검증 데이터는 콜센터 통화 녹취가 아니라 텍스트 대화/발화 라벨 데이터다. 따라서 전체 문장을 바로 삐 처리 사전에 넣으면 정상 민원 표현까지 오탐될 수 있다.

현재 파이프라인은 다음 기준으로만 후보를 뽑는다.

- `sentences[].types`에 `ABUSE` 또는 `SEXUAL`이 있는 문장만 사용한다.
- 전체 문장이 아니라 `mapped_slots[].token` 어휘 단위만 후보로 쓴다.
- 특정 라벨에서 반복 출현하고, 전체 출현 대비 라벨 비율이 높은 토큰만 선택한다.
- `하다`, `너`, `여자`처럼 너무 일반적인 단어와 발표 문맥에서 오탐 위험이 큰 강조 표현은 제외한다.
- 생성 결과는 검수 가능한 별도 파일로 두며, 원본 데이터와 생성 사전은 git에 올리지 않는다.

## 이미 받은 `download.tar`에서 생성

프로젝트 루트에서 실행한다.

```powershell
python scripts\extract_aihub_ethics_dictionary.py download.tar
```

생성 결과:

```text
backend/app/data/dictionaries.aihub.json
```

이 파일이 존재하면 FastAPI 백엔드가 시작될 때 기본 사전과 자동 병합한다. 파일을 지우면 기본 사전만 사용한다.

## WSL에서 AI-Hub API로 다시 받기

AI-Hub 데이터셋 다운로드 승인이 완료되어 있고 API 키가 있을 때만 가능하다.

```bash
cd /mnt/c/Users/yungg/Downloads/EmotionGuard
export AIHUB_API_KEY='...'
bash scripts/aihub_download_ethics.sh
python3 scripts/extract_aihub_ethics_dictionary.py data/aihub/text-ethics
```

기본 설정:

- 데이터셋 키: `558`
- 다운로드 파일 키: `61875,61877`
- 대상 파일: Training/Validation 라벨링 데이터

원천 데이터 파일은 실시간 묵음 처리 사전 생성에는 필요하지 않아 기본 다운로드 대상에서 제외한다.

## 런타임 정책

AI-Hub 확장 사전이 있을 때도 정책은 보수적으로 동작한다.

- 욕설 사전 매칭: 즉시 `mute` 액션과 보고서 기록
- 성희롱 사전 매칭: 명시적 사전 표현일 때만 즉시 `mute` 액션
- LLM 또는 fallback 맥락 판단 성희롱: 즉시 묵음이 아니라 경고, 에스컬레이션, 보고서에 사용

즉, 후보 데이터셋은 “발표 데모 및 사전 후보 확장”에는 쓰지만, 운영 환경에서는 수요기관 도메인 로그로 검수한 뒤 확정 사전에 승격하는 흐름이 필요하다.
