# EmotionGuard QA

EmotionGuard의 텍스트/음성 보호 성능을 검증하기 위한 QA 골든셋 영역입니다.

## 텍스트 QA

`text/emotionguard_text_qa_5000.jsonl`은 외부 공개 데이터셋에서 샘플링한 5,000건 QA 골든셋입니다.

사용 데이터:

- Korpora 문서에서 제공되는 `korean_hate_speech` 말뭉치 원천인 `kocohub/korean-hate-speech`
- KOLD: Korean Offensive Language Dataset (`boychaboy/KOLD`)

원본 데이터는 `qa/external/`에 캐시되며, 재다운로드 가능하므로 Git에는 올리지 않습니다.

## QA 행 구조

각 JSONL 행은 다음 정보를 포함합니다.

- `text`: 외부 데이터셋 원문 댓글
- `sourceDataset`, `sourceRepository`, `sourceExternalId`: 출처 추적 정보
- `sourceLabels`: 원본 라벨
- `request`: `/api/analyze`에 바로 넣을 요청 payload
- `expected`: EmotionGuard 기준 기대 결과

주요 기대값:

- `expected.eventType`: `normal` 또는 `abuse`
- `expected.maskedText`: 상담사/보고서 화면에 노출될 마스킹 기대 문장
- `expected.mustMask`: 내부 비윤리 표현 사전으로 별표 마스킹이 기대되는지
- `expected.contextRequired`: 직접 사전 단어가 약해 GPT 문맥 판단이 필요한지
- `expected.offensiveSpanHint`: KOLD의 공격 구간 힌트

## 생성

```powershell
python scripts/generate_text_qa_dataset.py
```

고정 seed를 사용하므로 같은 명령으로 같은 5,000건을 재생성할 수 있습니다.

원본 데이터를 다시 내려받으려면:

```powershell
python scripts/generate_text_qa_dataset.py --force-download
```

## 평가

백엔드 서버를 먼저 실행한 뒤 평가합니다.

```powershell
python scripts/evaluate_text_qa.py
```

기본값은 API 비용을 막기 위해 200건만 실행하고, 문맥 판단 케이스는 제외합니다.

전체 비문맥 케이스:

```powershell
python scripts/evaluate_text_qa.py --limit 0
```

문맥 판단 케이스까지 포함:

```powershell
python scripts/evaluate_text_qa.py --limit 0 --include-context
```
