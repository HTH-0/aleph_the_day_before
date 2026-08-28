# 오늘의 진짜 정보판 — 어제 생긴 GitHub 저장소

공개 원천의 값 하나를 매일 한 줄로 기록하고, 어제와 비교하고, **데이터가 오지 않을 때도 값을 지어내지 않는** 정보판입니다.

- 신호: **어제(KST) 하루 동안 생성된 공개 GitHub 저장소 수** — 검색 인덱스 기준, fork 제외, private 제외
- 출처: GitHub REST API 저장소 검색 (키 없음, CORS 허용, 인증 없이 IP당 분당 10회)
- 세는 구간: `created:{어제}T00:00:00+09:00..{어제}T23:59:59+09:00`
- 기준 시간대: `Asia/Seoul`
- 보존 저장소: `data/daily.json` (저장소에 커밋되는 파일)

정적 사이트 하나로 끝납니다. 서버도, 데이터베이스도, 비밀키도 없습니다.

---

## 1. 왜 이 값인가

"오늘 생긴 수"는 하루 종일 커지는 값이라 몇 시에 재느냐에 따라 달라집니다. Actions cron은 수십 분씩 밀리는 일이 흔하고, 그 차이가 그대로 전일 대비 변화에 노이즈로 섞입니다. 그래서 **이미 닫힌 어제 하루**를 셉니다. 몇 시에 재든 값이 같고, 검색 인덱스가 따라잡을 시간도 벌어 줍니다.

`created:` 한정자는 기본이 UTC라 그대로 쓰면 KST 날짜와 9시간 어긋납니다. 쿼리에 `+09:00`을 명시해 KST 하루로 자릅니다.

세는 대상이 GitHub 전체가 아니라 **검색 인덱스에 잡힌, fork 아닌 공개 저장소**라는 점은 화면에 그대로 밝힙니다.

부수 효과가 하나 있습니다. `source_time`(어제 23:59:59 KST)과 `fetched_at`(오늘 조회 시각)이 하루 차이가 나서, 두 시각을 왜 나눠 보여주는지가 화면에서 눈에 보입니다.

## 2. 왜 이렇게 만들었나

값이 잘 올 때는 어떤 구현이든 비슷해 보입니다. 갈리는 곳은 값이 늦거나, 거절당하거나, 형식이 바뀌었을 때입니다. 그래서 이 앱은 세 가지를 구조로 강제합니다.

1. **live adapter와 replay adapter가 같은 함수를 부른다.** 둘 다 `src/core.js`의 `applySuccessfulReading` / `applyError`만 통과합니다. 오류 처리만 따로 예쁘게 꾸미는 일이 구조적으로 불가능합니다.
2. **실패는 저장을 건드리지 않는다.** `applyError`는 `status`만 바꾸고 `daily_readings`에는 손대지 않습니다.
3. **화면의 변화값은 저장값에서 매번 다시 계산한다.** 미리 계산해 둔 delta를 저장하거나 표시하지 않습니다.

---

## 3. 화면 구성

조건이 화면 표시를 요구한 것만 넣었습니다. 세 구획입니다.

| 구획 | 내용 | 근거 |
|---|---|---|
| 지금 값 | 값·단위·출처·출처 관측 시각·조회 시각·기준 시간대, 신선도 배지, 실패 안내 | C04~C09, C18 |
| 보존된 일별 기록 | KST 날짜별 값·단위·어제 대비·출처 관측 시각·출처 URL | C23·C24의 화면 표시값 |
| 데이터가 안 올 때 | fixture 재생 버튼, 실패 5종 안내와 다음 행동, 다시 시도, 합성 상태 | C12~C19 |

자가검증과 해시 대조는 조건이 화면 표시를 요구하지 않아 스크립트로만 둡니다(`npm run verify`).

## 4. 파일 구조

```
index.html                   심사 화면 하나
src/core.js                  정규화·저장·비교·오류 분류 (live/replay 공용)
src/live-adapter.js          실제 공개 원천 조회 + 원자료 → 정규화
src/replay-adapter.js        공개 결정론 fixture 9종 재생
src/store.js                 data/daily.json 형식과 upsert·재계산 함수
src/app.js                   화면
data/daily.json              보존된 일별 기록 (Actions가 커밋)
vendor/aleph-t04/            공개 fixture 꾸러미 원본 (바이트 그대로)
scripts/record-daily.js      실제 조회 1회 → data/daily.json 갱신
scripts/selfcheck.js         fixture 7개 재생 순서 × expected 대조
scripts/verify-assets.js     vendor 파일 SHA-256 × asset-manifest.json 대조
.github/workflows/daily-record.yml   매일 09:30 KST 기록
```

---

## 5. 배포

1. 이 폴더를 GitHub 저장소 루트에 올립니다.
2. **Settings → Pages → Source: Deploy from a branch**, 브랜치 `main` / 폴더 `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**를 `Read and write permissions`로 둡니다. (일별 기록 커밋에 필요)
4. **Actions 탭 → 일별 기록 → Run workflow**를 눌러 첫날 기록을 만듭니다.
5. 다음 KST 날짜에 한 번 더 누르거나, 09:30 KST 자동 실행을 기다립니다.

> 저장소는 public이어야 합니다. 결과물 URL과 소스 URL 모두 로그인 없이 열려야 합니다.
>
> 소스 URL은 커밋을 고정해 제출하세요: `https://github.com/<계정>/<저장소>/tree/<40자리 commit sha>`

### 자동 기록이 막혔을 때 (수동 경로)

화면의 **오늘 기록 내보내기**를 누르면 방금 받은 실제 응답으로 만든 행이 그대로 나옵니다. 그 JSON을 `data/daily.json`의 `rows` 배열에 넣고 커밋하면 결과가 같습니다. 값을 손으로 고쳐 쓰지는 마세요 — 그러면 원자료·저장값·화면값 대조가 깨집니다.

---

## 6. 로컬에서 확인

```bash
node scripts/verify-assets.js   # 공개 fixture 꾸러미 해시 대조
node scripts/selfcheck.js       # 7개 재생 순서 × fixture expected 대조
node scripts/record-daily.js    # 실제 조회 1회 → data/daily.json
node scripts/serve.js           # http://localhost:8080
```

`npm run verify`로 앞의 두 개를 한 번에 돌릴 수 있습니다. 의존성은 없습니다(Node 20 이상).

---

## 7. 짧은 확인 방법

| | |
|---|---|
| **어디로** | 배포된 페이지 하나. 새 시크릿 창에서 로그인 없이 열립니다. |
| **무엇을** | ① `지금 다시 조회`를 누른다. ② 아래 `느린 응답`을 누른다. ③ 실패 상자의 `다시 시도`를 누른다. |
| **통과** | ①에서 값·단위·출처·출처 관측 시각·조회 시각·`Asia/Seoul`이 한 화면에 보인다. ②에서 `오래된 값 · timeout` 배지와 함께 마지막 정상값 105가 남고 행 1건. ③ 뒤 `새 값`, 행 2건, 새 합성 날짜 `2026-08-25` 행 1건, 값 120, 어제 대비 +15. |
| **안 될 때** | 큰 숫자 자리에 마지막 정상값이 남고 노란 안내 상자가 뜬다. 실패 다섯 종류가 서로 다른 문장과 서로 다른 다음 행동을 보여 준다. 보존된 일별 기록은 실패해도 줄지 않는다. |

---

## 8. 조건별로 어디를 보면 되는지

| 조건 | 확인 위치 |
|---|---|
| C01·C02·C29~C33 | 배포 URL·소스 URL 모두 인증 장치 없음. 로그인 UI 자체가 없음 |
| C03~C09 | `지금 값` — 값·단위·출처·출처 관측 시각·조회 시각·기준 시간대 |
| C10 | `지금 값`의 표시값 = `data/daily.json` 저장값 = 응답의 `total_count`. 개발자 도구 Network 탭에서 대조 가능 |
| C11 | 호출 주소에 키 파라미터 없음. `git grep -iE "api[_-]?key\|secret\|token"` 결과 없음 |
| C12~C16 | `데이터가 안 올 때` — 실패 5종 각각 다른 `error_code`와 다른 안내·다음 행동 |
| C17·C18 | 실패 뒤에도 행 1건과 마지막 정상값 105 유지, `오래된 값` 배지 표시 |
| C19 | 실패 상자의 `다시 시도` → `T04-RECOVER-D2` → `fresh/none`, 행 2건, 신규 행 1건 |
| C20·C21 | `record_id = signal_id:record_date` 단일 키 upsert. `node scripts/selfcheck.js`로 확인 |
| C22~C24 | `보존된 일별 기록` — `data/daily.json`의 실제 KST 날짜 2건과 어제 대비 값 |
| C25 | 저장소 개수만 저장. 소유자·이름·URL을 받지도 보여주지도 않음. 쿠키·로컬스토리지 미사용 |
| C26 | 실패 재생 입력은 전부 `vendor/aleph-t04/fixtures/*.json`. `node scripts/verify-assets.js`로 해시 대조 |
| C34·C35 | 제출 폼에 HTTPS 결과물 URL 1개, commit sha가 포함된 소스 URL 1개 |

---

## 9. 비밀값과 개인정보

- 호출 주소에 인증 파라미터가 없습니다. 브라우저 개발자 도구의 Network 탭에서 요청 전체를 봐도 감출 값이 없습니다.
- `.env` 파일이 없고, 코드가 환경변수를 읽지 않습니다.
- Actions는 GitHub이 자동으로 주는 `GITHUB_TOKEN`만 씁니다. 저장소에 등록한 secret이 없습니다.
- 집계 수치 하나만 다룹니다. 저장소 소유자나 이름 같은 개인 식별 정보는 받지 않습니다(`per_page=1`, `items`는 무시).
- 쿠키, localStorage, sessionStorage, 분석 스크립트를 쓰지 않습니다. 합성 재생 상태는 메모리에만 있고 새로고침하면 사라집니다.

---

## 10. 합성 fixture가 대신하지 않는 것

`vendor/aleph-t04/fixtures`의 `2026-08-24` / `2026-08-25`는 합성 시계입니다. 저장·실패·계산 경로를 재현할 뿐이고, 실제 공개 원천 조회와 서로 다른 실제 KST 날짜 2건을 대신하지 않습니다. 실제 증거는 `data/daily.json`의 커밋 이력에 있습니다.
