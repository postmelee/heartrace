# PPG 보정 및 검증 기준

이 앱의 PPG는 의료 진단이 아니라 “관측된 심장 박동 한 번 = 경기의 한 걸음”인
전시 입력 장치입니다. 따라서 표시 BPM의 안정성만 높이는 평균화와 실제 박동
이벤트의 판정을 분리합니다. 영상은 저장하거나 전송하지 않습니다.

## 현재 런타임 파이프라인

### 1. 카메라 획득과 접촉

- 후면 물리 카메라와 torch를 사용하고 중앙 ROI의 RGB 평균, 공간 표준편차,
  포화 픽셀 비율을 30 Hz로 계산합니다.
- 손가락 접촉 뒤 red 평균이 192–236 범위가 되도록 노출을 조절한 다음 iOS
  노출과 white balance를 고정합니다.
- 접촉 진입은 5프레임, 이탈은 24프레임 연속 확인하는 hysteresis로 짧은 색
  변화가 전체 필터 reset으로 이어지지 않게 합니다.
- red가 포화되거나 신호가 약하면 green을 비교하지만, 한 번 선택한 채널은
  최소 4초 유지해 채널 왕복 전환을 막습니다.

### 2. qPPG 계열 실시간 검출

- 카메라 밝기는 혈액량이 늘 때 감소하므로 필터 내부에서 극성을 반전합니다.
  이 처리가 빠지면 공개 스마트폰 PPG에서 이중 peak를 주박동으로 오인해 BPM이
  약 두 배가 되는 것을 전체 데이터 재생으로 확인했습니다.
- 0.5 Hz high-pass와 5 Hz low-pass를 적용한 뒤, 최근 170 ms 양의 기울기를
  더하는 slope-sum 신호를 만듭니다.
- 최근 1.5초 slope-sum의 55/90 백분위로 adaptive threshold를 만들고,
  threshold 아래로 충분히 내려간 뒤에만 다음 후보를 받습니다.
- 270–2,000 ms의 생리적 절대 범위와 refractory를 적용합니다.

이 구조는 qppgfast의 “170 ms slope-sum + adaptive threshold”를 앱의 30 Hz
스트리밍 처리에 맞춰 TypeScript로 독립 구현한 것입니다. MSPTDfast는 4–8초
창에서 강한 오프라인 비교 기준으로 사용하되, 한 박동마다 즉시 이동해야 하는
런타임에는 사용하지 않습니다.

### 3. 품질 점수와 artifact 분류

하나의 모호한 `quality`만 쓰지 않고 아래 값을 trace에 각각 남깁니다.

- `contactQuality`: red 우세도와 밝기를 이용한 손가락 접촉
- `opticalQuality`: 맥동 진폭, 노출 headroom, ROI 균일도와 포화 비율
- `motionQuality`: 현재는 연속 프레임 RGB 변화량 기반의 카메라 motion proxy
- `rhythmConfidence`: 최근 IBI 중앙값과 MAD 계열 일관성
- `decision`: threshold 미달, motion 거절, refractory, extra peak, 관측,
  누락 간격 회복 등의 최종 분류

빠른 후보가 최근 IBI의 72%보다 짧으면 dicrotic notch/이중 peak 가능성이 있어
연속 후보를 확인합니다. 거의 두 배 심박으로 보이는 전환은 세 간격을 요구하고,
더 완만한 전환은 두 간격을 요구합니다. 반대로 한두 박동이 누락된 길이의 간격은
최근 IBI의 2배 또는 3배인지 확인해 BPM 기준선에는 정규화된 IBI를 사용합니다.
정규화된 누락 복구 IBI가 기존 cadence와 맞지 않으면 경기 이벤트에는 사용하되
그 값 하나로 새 BPM 전환 후보를 준비하지 않습니다.

60 BPM 아래로 잘못 잠긴 상태에서는 30 Hz 양자화와 파형 지점 교대로 빠른 후보
간격의 편차가 커질 수 있어 세 후보 조건은 유지하되 간격 허용 폭만 넓힙니다.
이로써 공개 정상 품질 레코드에서 half-rate lock을 줄였습니다.

### 4. 박동 이벤트, BPM, 짧은 신호 공백

- 카메라에서 확인한 경기 이벤트는 `source: "observed"`입니다.
- BPM은 최근 IBI 이력으로 안정화하지만, BPM 기준선의 전환 보류가 모든 정상
  관측 이벤트를 연쇄적으로 막지 않도록 분리합니다.
- 짧은 공백에서는 마지막 cadence로 `source: "bridged"` 한 번만 보냅니다.
  실제 관측이 돌아오기 전 두 번째 보간은 만들지 않습니다.
- 손가락 압력 변화 뒤 2초 넘는 공백이 생겨도 접촉과 최근 cadence 이력이
  유지된 경우, 처음 돌아온 실제 후보를 baseline으로 버리지 않고 관측 박동으로
  전달합니다. 긴 공백 자체는 IBI로 사용하지 않아 BPM 급락은 막습니다.
- 앱과 서버 모두 관측 사이의 연속 `bridged` 이벤트를 한 번으로 제한합니다.
- 서버는 UUID/sequence/시각, 270–2,000 ms 절대 범위, 최소 품질만 검사합니다.
  원시 PPG가 없는 서버가 과거 IBI로 cadence를 다시 판정하거나 BPM을 다시
  계산하지 않습니다.

이 정책은 긴 신호 손실 동안 가상의 심장으로 계속 달리는 것은 막으면서, 화면
전환이나 단일 threshold 누락이 경기의 멈춤으로 바로 느껴지지 않게 합니다.

## 공개 데이터 회귀

[BUT PPG 1.0.0](https://physionet.org/content/butppg/1.0.0/)은 스마트폰 카메라
30 Hz PPG, 동시 ECG 기반 기준 심박, 전문가 품질 레이블을 가진 48개의 10초
기록입니다. 데이터셋을 내려받아 아래처럼 실제 WFDB 16-bit/gain/baseline을
복원해 전체 레코드를 재생합니다.

```sh
npm run benchmark:ppg:but -- /absolute/path/to/but-ppg-1.0.0
```

현재 결과(2026-08-13):

| 정상 품질 레코드                                    |      값 |
| --------------------------------------------------- | ------: |
| 검출된 레코드                                       | 35 / 35 |
| 최종 BPM 평균 절대 오차                             | 2.9 BPM |
| 10 BPM 초과 오차                                    |  1 / 35 |
| 180 BPM 이상 spike                                  |  0 / 35 |
| 관측 박동 수 / 기준 BPM으로 추정한 박동 수          |   77.3% |
| 한 번의 bridge를 포함한 게임 이동 수 / 추정 박동 수 |   84.8% |
| 첫 관측이 3초를 넘은 레코드                         |  0 / 35 |

`quality=0`인 13개는 원 데이터의 전문가가 심박 추정에 부적합하다고 판정한
기록이므로 BPM 정확도 목표에 포함하지 않습니다. 또한 BUT PPG의 기준값은 각
10초 기록의 단일 median HR이지 beat timestamp annotation이 아닙니다. 위 박동
검출률은 참고용 근사치이며 sensitivity/PPV/F1으로 해석하면 안 됩니다.

저장소에는 CC BY 4.0인 105001 정규화 fixture도 포함해 polarity, 초기 spike와
최종 BPM을 단위 회귀로 검사합니다. 추가 detector 비교에는 ECG beat annotation이
있는 BIDMC 같은 데이터와 MSPTDfast를 사용할 수 있지만, 임상 센서 데이터는
스마트폰 노출·손가락 압력 평가를 대신하지 못합니다.

## iPhone 숫자형 trace

개발 진단 UI의 `PPG 로그 공유`는 약 3분간 아래 숫자만 JSON으로 공유합니다.

- RGB 평균과 ROI 공간 표준편차, 포화 비율
- 선택 채널, slope-sum/threshold
- 품질 구성요소와 `decision`
- observed/bridged 박동, IBI, BPM, confidence

경기가 끝나도 새 측정을 명시적으로 시작하기 전까지 trace를 보존합니다. 저장한
JSON은 다음 명령으로 요약합니다.

```sh
npm run analyze:ppg:trace -- /absolute/path/to/trace.json
```

분석기는 접촉률, 첫 박동 지연, 최장 박동 공백, bridge 수, 각 `decision`의 비율과
품질 구성요소 p10/median/p90을 출력합니다. 다음 iPhone 테스트에서는 최소한
안정 30초, 의도적 압력 변화, 작은 움직임, 운동 직후 고심박을 각각 분리해 trace를
남깁니다.

## 아직 남은 제한

- 실제 accelerometer는 아직 연결하지 않았습니다. 현재 motion은 RGB 프레임
  변화 proxy이므로, 첫 실측 trace에서 `motion_rejected`와 실제 움직임이 맞지
  않으면 `expo-sensors`를 추가하고 새 네이티브 빌드로 보강합니다.
- 카메라 모델, 렌즈와 피부/손가락 압력에 따라 색 범위와 진폭이 달라집니다.
  공개 Xiaomi 데이터에서 맞은 임계값을 iPhone 정답으로 간주하지 않습니다.
- 부정맥이나 매우 불규칙한 실제 IBI는 artifact와 구분하기 어렵습니다. 이 앱은
  의료 결과를 표시하지 않지만, 경기 입력에서도 신뢰도 저하를 사용자에게 즉시
  안내해야 합니다.

## 참고 자료

- 공개 검출기 벤치마크: [Charlton et al., 2022](https://openaccess.city.ac.uk/id/eprint/28452/8/Charlton_2022_Physiol._Meas._43_085007.pdf)
- qppgfast와 MSPTDfast 비교/구조: [Charlton et al., 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC11894679/)
- 스마트폰 접촉 압력·motion의 이중 peak: [Jonathan & Leahy, 2014](https://pmc.ncbi.nlm.nih.gov/articles/PMC3949790/)
- 적응형 RR artifact 분류: [Lipponen & Tarvainen, 2019](https://pubmed.ncbi.nlm.nih.gov/31314618/)
- 스마트폰 PPG 공개 데이터: [BUT PPG 1.0.0](https://physionet.org/content/butppg/1.0.0/)
