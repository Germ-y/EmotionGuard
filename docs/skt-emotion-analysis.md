# SKT 음성 감정 데이터 적용 메모

## 현재 확인 결과

`SKT데이터/` 폴더에는 아직 추출된 wav/라벨 파일이 아니라 다운로드 조각이 들어 있다.

- `small.tar.irx875`: tar 조각이며 내부에 `small/F2001.tar`가 시작되지만 전체 85,370,880바이트 중 일부만 있다.
- `small.tar.irx508`: 동일하게 `small/F2001.tar`가 시작되는 조각이다.
- `large.tar.irx875`: tar 조각이며 `large/F0001.tar`, `large/F0002.tar`, `large/F0003.tar`가 보이지만 `F0003.tar` 중간에서 끊긴다.
- `large.tar`, `small.tar`: 0바이트라 완성된 본체가 아니다.

따라서 지금 상태로는 실제 음성 메타데이터를 직접 추출할 수 없고, 완성된 tar를 병합/추출한 뒤 진행해야 한다.

## 가능한 감정 분석 구조

추출이 완료되면 SKT 데이터는 EmotionGuard의 감정 분석 학습/검증 데이터로 사용할 수 있다.

1. wav 파일과 라벨 CSV/JSON을 `audio_id` 기준으로 매칭한다.
2. 음성에서 `rms`, `peak`, `zero_crossing_rate`, `spectral_centroid`, `pitch`, `duration`을 추출한다.
3. 라벨의 감정값을 `normal`, `frustrated`, `angry`, `threatening` 같은 서비스 내부 감정 클래스로 매핑한다.
4. 1차로는 규칙/통계 기반 감정 보조 점수를 만들고, 이후 모델링 데이터가 충분하면 Wav2Vec2/WavLM 계열 모델로 교체한다.
5. 추론 결과는 기존 `audioFeatures` 옆에 `emotionPrediction`으로 붙여 LLM 성희롱/협박 판단의 보조 근거로 사용한다.

## 메타데이터 추출 명령

압축을 푼 뒤 아래 명령으로 학습용 CSV를 만든다.

```powershell
python scripts\extract_skt_emotion_metadata.py .\SKT데이터\extracted --output data\skt\skt_emotion_metadata.csv
```

현재처럼 tar 조각만 있는 폴더에 실행하면 archive 상태만 점검한다.

```powershell
python scripts\extract_skt_emotion_metadata.py .\SKT데이터
```

출력 CSV 주요 컬럼:

- `audio_id`
- `audio_path`
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
