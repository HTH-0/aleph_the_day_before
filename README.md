# 오늘의 진짜 정보판 — 어제 생긴 공개 저장소

어제(KST) 하루 동안 새로 만들어진 공개 GitHub 저장소 수를 매일 한 줄씩 기록하고, 어제와 비교하고,
데이터가 오지 않을 때도 값을 지어내지 않고 정직하게 설명하는 정보판입니다.

- 신호: 어제(Asia/Seoul) 00:00~23:59 사이에 생성된 공개 저장소 수
- 정의: GitHub 검색 인덱스 기준 · fork 제외 · public 만
- 출처: GitHub REST API 저장소 검색 (인증 없음, 비밀키 없음)
- 기준 시간대: `Asia/Seoul`

## 왜 "어제"인가

"오늘 생긴 수"는 하루 종일 늘어나므로 몇 시에 재느냐에 따라 값이 달라집니다. 그러면 어제 대비 변화가
값의 변화가 아니라 측정 시각의 변화를 나타내게 됩니다. 이미 닫힌 하루를 세면 몇 시에 조회해도 같은 값이 나옵니다.
검색 조건의 시각에는 `+09:00` 오프셋을 명시해 UTC 기준과 어긋나지 않게 했습니다.

부수 효과로 출처 시각(어제 23:59:59 KST)과 조회 시각(오늘)이 하루 차이가 나서, 두 시각을 왜 나눠서
보여 주는지가 화면에서 그대로 드러납니다.

## 실행

```bash
node scripts/serve.js      # http://localhost:4173
```

빌드 단계가 없습니다. 정적 파일과 ES 모듈만 씁니다.

## 점검 명령

```bash
npm run verify-assets   # vendor/aleph-t04 17개 파일 SHA-256 대조
npm run selfcheck       # 재생 순서 7가지 · 실패 5종 · 회복 전이 대조
npm run scan-secrets    # 비밀값 원문 검색
npm run check           # 위 세 가지 연속 실행
npm run record          # 실제 조회 1회 → data/daily.json
```

## 구조

```
index.html                  심사 화면 하나 (칸 6개)
src/core.js                 정규화 검증 · 일별 저장 · 전일 대비 · 오류 분류   ★공용
src/live-adapter.js         실제 조회 + 원자료 → 정규화
src/replay-adapter.js       공개 fixture 9종 → outcome
src/store.js                data/daily.json 형식 · upsert · 변화 재계산
src/app.js                  화면 로직
src/style.css               스타일
data/daily.json             보존된 일별 기록 (Actions 가 커밋)
vendor/aleph-t04/           공개 fixture 꾸러미 원본 — 바이트 그대로, 수정 금지
scripts/                    기록 · 자가검증 · 해시 대조 · 비밀값 검색 · 로컬 서버
.github/workflows/daily-record.yml   매일 09:30 KST 기록
```

### 설계 원칙 세 가지

1. live 경로와 replay 경로가 모두 `core.js` 의 `applyOutcome` 하나만 통과합니다.
   오류 처리만 따로 예쁘게 꾸미는 일이 구조적으로 불가능합니다.
2. `applyError` 는 `status` 만 바꾸고 `daily_readings` 와 `current_reading` 은 건드리지 않습니다.
   실패가 저장된 정상값을 지우거나 덮어쓸 수 없습니다.
3. 어제 대비 변화는 저장 시점에 계산해 두지 않고, 화면을 그릴 때마다 두 저장값에서 다시 뺍니다.

## 화면 6칸

| 칸 | 내용 |
| --- | --- |
| 01 지금 값 | 큰 숫자 · 단위 · 전일 대비 · 정직 스트립 · 값/단위/출처/출처 시각/조회 시각/기준 시간대 |
| 02 대조표 | 원자료 · 저장값 · 화면값 6행, 행마다 일치 판정 (화면값은 DOM 에서 실제로 읽습니다) |
| 03 보존 기록 | `data/daily.json` 표와 뺄셈식 재계산 패널 |
| 04 장애 재생 | fixture 9개 버튼, 실패 5종이 서로 다른 문장·다음 행동, 다시 시도 → 회복 |
| 05 자가검증 | 공개 꾸러미 해시 대조 + 재생 순서 7가지를 브라우저에서 다시 실행 |
| 06 확인 방법 | 4줄 확인법과 지키는 규칙 |

## 배포

### GitHub Pages

1. Settings → Pages → Source: `Deploy from a branch`, 브랜치 `main`, 폴더 `/ (root)`
2. `.nojekyll` 이 이미 있으므로 추가 설정은 없습니다.

### Vercel (선택)

Framework `Other`, Build Command 비움, Output Directory `.`
**Deployment Protection 은 반드시 꺼야 합니다.** 켜져 있으면 로그인 화면이 떠서 공개 접근 조건이 한 번에 깨집니다.
프로덕션 도메인만 제출하고 `-git-main-` 이 붙은 미리보기 주소는 쓰지 않습니다.

### 일별 기록 워크플로

1. Settings → Actions → General → Workflow permissions → `Read and write permissions`
2. Actions 탭 → `일별 기록` → `Run workflow` 로 첫 기록을 남깁니다.
3. 다음 KST 날짜에 자동(09:30 KST) 또는 수동으로 한 번 더 실행합니다.

조회가 실패하면 워크플로는 값을 만들지 않고 그대로 끝납니다. `[실패] timeout` 같은 출력은 버그가 아니라
설계된 동작입니다. 잠시 뒤 다시 실행하세요.

## 지키는 규칙

- 비밀키가 필요 없는 공개 출처만 조회합니다. 토큰도 인증 헤더도 쓰지 않습니다.
- 개인정보나 개인 기록을 저장하지도 표시하지도 않습니다.
- 브라우저 저장소(localStorage)와 쿠키를 쓰지 않습니다. 보존 기록은 커밋된 파일 하나입니다.
- 실패했을 때 값을 지어내지 않고 마지막 정상값을 오래된 값이라고 표시합니다.
- 기록이 한 건이면 변화를 계산하지 않고 한 건이라고 말합니다.
- `vendor/aleph-t04/` 는 바이트 그대로 둡니다. 수정하면 해시 대조가 깨집니다.
- fixture 의 `2026-08-24` / `2026-08-25` 는 합성 시계입니다. 실제 KST 날짜 2건을 대신하지 않습니다.
