# 감정 음성 메타데이터 구조

EmotionGuard의 성희롱 판단은 텍스트 사전만으로 끝내지 않는다. 명시적인 성희롱 표현은 로컬 사전으로 즉시 처리하고, 애매한 발화는 STT 텍스트, LLM 문맥 판단, 음향 메타데이터를 함께 사용한다.

## 실시간 메타데이터

브라우저 마이크 입력에서 다음 값을 즉시 계산한다.

| 항목 | 의미 | 사용 위치 |
| --- | --- | --- |
| `rmsPercent` | 현재 음량 레벨 | 고성 완화, 위험도 보조 |
| `peak` | 프레임 최대 진폭 | 순간 고음량 확인 |
| `pitchHz` | 추정 기본 주파수 | 감정/긴장도 보조 |
| `zeroCrossingRate` | 파형 부호 전환 비율 | 거친 발화/잡음 보조 |
| `spectralCentroidHz` | 주파수 중심 | 음색 변화 보조 |
| `syllablesPerSecond` | 발화 속도 추정 | 흥분/긴장도 보조 |

이 값들은 성희롱 여부를 직접 결정하지 않는다. 높은 피치나 큰 음량만으로 성희롱이라고 판단하지 않고, LLM 문맥 판단의 보조 근거로만 사용한다.

## KEMDy20 메타데이터 추출

KEMDy20는 `annotation`, `EDA`, `IBI`, `TEMP`, `wav/*.txt` 태그를 세그먼트 ID 기준으로 합쳐 분석할 수 있다. 현재 공개 파일에 wav가 없더라도 생체신호와 라벨 메타데이터는 CSV로 정리할 수 있다.

```powershell
python scripts\extract_kemdy20_metadata.py KEMDy20_v1_3.zip
```

기본 출력:

```text
data/kemdy20/kemdy20_metadata.csv
```

출력 컬럼에는 `emotion`, `arousal`, `valence`, `eda_mean`, `ibi_mean`, `temp_mean`, `sound_tags`가 포함된다. wav가 포함된 버전을 넣으면 `duration_s`, `audio_rms`, `audio_peak`, `audio_zero_crossing_rate`도 함께 계산한다.

## 모델링 연결

다운로드가 완료되기 전에는 `audioFeatures`를 LLM에 전달하는 방식으로 데모한다. 이후 AI-Hub 감정 음성 데이터셋이 준비되면 다음 단계로 확장한다.

```text
AI-Hub 감정 음성 데이터셋
  -> 음향 메타데이터 추출
  -> WavLM/Wav2Vec2 기반 감정 모델 학습
  -> 실시간 발화 emotion/arousal 추정
  -> LLM 성희롱 문맥 판단의 보조 입력
```

즉, 현재 구현은 모델이 붙기 전의 입력 계약과 시각화 계층이고, 모델링이 끝나면 `audioFeatures` 옆에 `emotionPrediction`을 추가하면 된다.
