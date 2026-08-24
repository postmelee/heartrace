# Third-party notices

심장달리기는 아래 오픈소스 소프트웨어와 공개 연구 데이터를 사용합니다.

## Pretendard 1.3.9

- Author: Kil Hyung-jin
- Source: https://github.com/orioncactus/pretendard
- License: SIL Open Font License 1.1
- Use: 웹과 모바일 앱의 한글·영문 UI 글꼴

라이선스 전문은 설치 패키지의 `node_modules/pretendard/dist/LICENSE.txt`와
웹 배포물의 `apps/host/public/third-party-notices.txt`에 포함되어 있습니다.

## BUT PPG 1.0.0

- Source: https://physionet.org/content/butppg/1.0.0/
- License: Creative Commons Attribution 4.0 International
- Use: PPG 검출 회귀 테스트를 위한 record 105001의 정규화된 10초 red-channel
  fixture

해당 fixture는 제품 런타임이나 브라우저 플레이 빌드에 포함되지 않으며 테스트에만
사용됩니다. 원 데이터의 출처와 라이선스는
`packages/ppg-core/test/fixtures/butppg-105001.ts`에도 기록합니다.

## Runtime libraries

React, React Native, Expo, Express, Socket.IO, Vite, Vitest와 기타 npm 의존성은
각 패키지에 포함된 오픈소스 라이선스에 따라 사용합니다. 정확한 버전은
`package-lock.json`에 고정되어 있습니다.
