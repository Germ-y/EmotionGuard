# SKT 음성 감정 데이터 적용 메모

## 현재 확인 결과

`small.tar` 완성본을 확인했다.

- 파일 크기: 약 44.7GB
- 최상위: `small/`
- 내부 tar: 500개
- 화자 prefix: `F` 249개, `M` 251개
- 각 내부 tar 예시: `F2001/wav_48000/*.wav`, `M6003/wav_48000/*.wav`

현재 `small.tar`에서 확인된 구성은 wav 음성 중심이다. 감정 라벨/전사 CSV 또는 JSON이 별도 폴더에 있으면 `--labels` 옵션으로 함께 넘겨 `audio_id` 기준 매칭을 수행한다.

## 가능한 감정 분석 구조

추출이 완료되면 SKT 데이터는 EmotionGuard의 감정 분석 학습/검증 데이터로 사용할 수 있다.

1. wav 파일과 라벨 CSV/JSON을 `audio_id` 기준으로 매칭한다.
2. 음성에서 `rms`, `peak`, `zero_crossing_rate`, `spectral_centroid`, `pitch`, `duration`을 추출한다.
3. 라벨의 감정값을 `normal`, `frustrated`, `angry`, `threatening` 같은 서비스 내부 감정 클래스로 매핑한다.
4. 1차로는 규칙/통계 기반 감정 보조 점수를 만들고, 이후 모델링 데이터가 충분하면 Wav2Vec2/WavLM 계열 모델로 교체한다.
5. 추론 결과는 기존 `audioFeatures` 옆에 `emotionPrediction`으로 붙여 LLM 성희롱/협박 판단의 보조 근거로 사용한다.

## 메타데이터 추출 명령

완성된 `small.tar`는 압축을 풀지 않고 바로 학습용 CSV로 변환할 수 있다.

샘플 20개만 빠르게 확인:

```powershell
python scripts\extract_skt_emotion_metadata.py .\small.tar --limit 20 --output data\skt\skt_emotion_metadata_sample.csv
```

전체 생성:

```powershell
python scripts\extract_skt_emotion_metadata.py .\small.tar --output data\skt\skt_emotion_metadata.csv
```

라벨 폴더가 별도로 있을 때:

```powershell
python scripts\extract_skt_emotion_metadata.py .\small.tar --labels .\SKT데이터\labels --output data\skt\skt_emotion_metadata.csv
```

출력 CSV 주요 컬럼:

- `audio_id`
- `audio_path`
- `speaker_id`
- `speaker_gender`
- `emotion`
- `transcript`
- `duration_s`
- `sample_rate`
- `audio_rms`
- `audio_peak`
- `audio_zero_crossing_rate`
- `spectral_centroid_hz`
- `pitch_hz`
- `pitch_confidence`
