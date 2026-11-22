// 노드 파이프라인(T-194) 관심사별 출처 설정. 공식·공공 출처만(D-5): 위키·인벤·블로그는 넣지 않는다.
// - allowHost(host): 후보 노드 sources에 쓸 수 있는 호스트(check가 검사)
// - listings: 목록 페이지(index가 읽어 상세 페이지 링크를 모은다). linkPattern에 맞는 링크만, titleFilter가 있으면 제목도 맞아야.
//   stripQuery면 링크의 ?page=… 같은 꼬리를 떼고 본다(메이플 뉴스 목록)
// - seeds: 목록 없이 바로 넣는 상세 페이지(식당: 기존 그래프가 실제로 열어 확인한 공공 자료 + 사전)
// - content: 본문 구역 표지(경로 정규식 → { start, end }). 없으면 페이지 전체에서 머리·꼬리·메뉴를 뺀 글
// - sectionSkip: 긴 글을 절로 나눌 때(T-195) 건너뛸 절 제목 정규식(없으면 모두 초안)
// - rules: 사실 검사 규칙(규칙 2·기존 그래프 단위 테스트와 맞춘다)

const MAPLE = 'https://maplestory.nexon.com';

// 메이플 가이드는 목록 페이지가 스크립트로 그려져서, 공식 가이드 검색(/Guide/N23GameInformation/Articles/Search, robots 허용)을
// 주제어로 돌려 글 링크를 모은다. 주제어는 기존 노드 영역 + 1,000개를 향한 넓은 영역
export const MAPLE_GUIDE_KEYWORDS = [
  '강화', '잠재능력', '큐브', '스타포스', '심볼', '보스', '길드', '경매장', '메소', '파티', '유니온', '링크',
  '전직', '스킬', '퀘스트', '사냥', '경험치', '펫', '코디', '이벤트', '월드', '거래', '교환', '제작',
  '전문기술', '몬스터파크', '무릉도장', '에픽 던전', '어빌리티', '하이퍼', '헥사', '솔 에르다', '세트', '익스트림'
];

export const INTERESTS = {
  maplestory: {
    id: 'maplestory',
    domain: '메이플스토리',
    allowHost: h => h === 'maplestory.nexon.com',
    listings: [
      // 가이드 검색: 주제어마다 첫 쪽(필요하면 --pages로 늘린다)
      ...MAPLE_GUIDE_KEYWORDS.map(k => ({
        kind: 'guide',
        url: `${MAPLE}/Guide/N23GameInformation/Articles/Search?page={page}&keyword=${encodeURIComponent(k)}`,
        linkPattern: /^https:\/\/maplestory\.nexon\.com\/guide\/n23gameinformation\/articles\/\d+$/i
      })),
      { kind: 'guide', url: `${MAPLE}/Guide/N23GameInformation`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/guide\/n23gameinformation\/articles\/\d+$/i, paged: false },
      { kind: 'update', url: `${MAPLE}/News/Update?page={page}`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/news\/update\/\d+$/i, stripQuery: true },
      { kind: 'notice', url: `${MAPLE}/News/Notice?page={page}`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/news\/notice\/\d+$/i, stripQuery: true }
    ],
    seeds: [],
    // 초안 우선순위: 구조 설명이 많은 가이드 → 업데이트(패치 노트) → 공지(점검 안내가 많아 수확이 낮다)
    kindOrder: ['guide', 'update', 'notice'],
    // 절 나누기(T-195)에서 건너뛸 절 제목: 금방 사라지는 이벤트·일정·보상, 오류 수정 목록, 댓글·메뉴. LLM 호출을 아낀다
    sectionSkip: /이벤트|버닝|패스|PC방|미니게임|쿠폰|점검|선착순|접속 보상|댓글|오류 수정|^캐시(샵)?$|^뉴스$|일정|기간|보상 안내|스킬 수정 사항/,
    // 초안에서 뺄 페이지 제목: 스킬 수치 조정 패치(2026-11-22 묶음 4에서 절 6개 → 후보 0)
    pageSkip: /스킬 조정/,
    content: [
      { path: /^\/guide\//i, start: 'class="cv_main"', end: 'class="cv_footer"' },
      { path: /^\/news\//i, start: 'class="new_board_con"', end: 'id="footer"' }
    ],
    rules: {
      allowAliases: true,          // 은어는 검토 표시(warn)와 함께 허용(T-114)
      allowLatin: true,            // HEXA 같은 공식 표기
      // 이름처럼 굳은 차수(6차 전직)는 자주 바뀌는 수치가 아니다. 그 밖의 숫자는 모두 실패
      numberAllow: [/\d+차(?=\s|$|[^\d])/g]
    }
  },
  restaurant: {
    id: 'restaurant',
    domain: '식당',
    // 공공·공식 자료만(restaurant.test.mjs와 같은 기준): *.go.kr, 정책브리핑, 소상공인시장진흥공단
    allowHost: h => h.endsWith('.go.kr') || h === 'www.korea.kr' || h === 'www.sbiz.or.kr',
    listings: [
      { kind: 'press', url: 'https://www.korea.kr/news/policyNewsList.do?pageIndex={page}', linkPattern: /^https:\/\/www\.korea\.kr\/news\/policyNewsView\.do\?newsId=\d+$/ },
      { kind: 'press', url: 'https://www.mafra.go.kr/bbs/home/792/artclList.do?page={page}', linkPattern: /^https:\/\/www\.mafra\.go\.kr\/bbs\/home\/792\/\d+\/artclView\.do$/ },
      { kind: 'press', url: 'https://www.moel.go.kr/news/enews/report/enewsList.do?pageIndex={page}', linkPattern: /^https:\/\/www\.moel\.go\.kr\/news\/enews\/report\/enewsView\.do\?news_seq=\d+$/ }
    ],
    // 보도자료 목록은 분야가 넓어서 제목에 식당 운영 단어가 있는 글만
    titleFilter: /식당|음식점|외식|식품|위생|가맹|프랜차이즈|최저임금|주휴|소상공인|자영업|배달|부가가치세|간이과세|원산지|식재료|농산물|물가|상가|임대차|권리금|영업|노쇼|예약|메뉴|가격표시/,
    seeds: [
      // 기존 식당 그래프가 실제로 열어 확인한 공공 자료(T-168) + 생활법령·사전
      { kind: 'law', title: '생활법령 음식점 창업', url: 'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?csmSeq=840&ccfNo=1&cciNo=1&cnpClsNo=1' },
      { kind: 'law', title: '생활법령 음식점 영업', url: 'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?csmSeq=840&ccfNo=1&cciNo=3&cnpClsNo=1' },
      { kind: 'law', title: '생활법령 상가 임대차', url: 'https://easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=627&ccfNo=4&cciNo=3&cnpClsNo=3' },
      { kind: 'law', title: '생활법령 가맹사업', url: 'https://easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=839&ccfNo=4&cciNo=1&cnpClsNo=2' },
      { kind: 'agency', title: '공정위 가맹사업 정보공개서', url: 'https://www.ftc.go.kr/www/contents.do?key=347' },
      { kind: 'agency', title: '식품안전나라 위생등급', url: 'https://www.foodsafetykorea.go.kr/portal/board/boardDetail.do?menu_no=3397&menu_grp=MENU_NEW03&bbs_no=newbbs12' },
      { kind: 'agency', title: '최저임금위원회 결정 과정', url: 'https://www.minimumwage.go.kr/minWage/process/main.do' },
      { kind: 'agency', title: '서울 상권분석 서비스', url: 'https://golmok.seoul.go.kr/fixedAreaAnalysis.do' },
      { kind: 'agency', title: '커리어넷 조리사 직업정보', url: 'https://www.career.go.kr/cnet/app/base/job/jobView.m?SEQ=173' },
      // 국세청 사업자 세무 안내(T-195): 식당을 차리고 운영하며 만나는 세금 구조. 생활법령이 503일 때도 열림(2026-11-22)
      ...[
        ['부가가치세', 2272, 7693], ['원천세', 2289, 7701], ['사업자등록 신청', 2444, 7777], ['사업자등록 정정', 2446, 7779],
        ['휴업·폐업', 2447, 7780], ['현금영수증·신용카드', 2468, 7793], ['전자세금계산서', 2460, 7786], ['세금 납부 안내', 2364, 7741],
        ['세액감면 및 절세혜택', 41127, 239082], ['징수유예', 41130, 239085]
      ].map(([title, mi, id]) => ({ kind: 'agency', title: `국세청 ${title}`, url: `https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=${mi}&cntntsId=${id}` }))
    ],
    kindOrder: ['law', 'agency', 'press'],
    // 절 나누기(T-195): 본문 표지가 없는 공공 페이지는 메뉴·만족도 조사 제목도 절이 된다(농식품부 보도자료 5쪽에서 호출 10번 → 후보 0)
    sectionSkip: /Skip Navigation|콘텐츠 만족도|바로가기|^보도자료$|사이트맵|전체메뉴|^메뉴$/i,
    content: [
      { path: /policyNewsView/, start: 'class="article_body"', end: 'class="article_footer"' }
    ],
    rules: {
      allowAliases: false, // 식당 그래프는 별칭이 없다(restaurant.test.mjs). apply가 뺀다
      allowLatin: false,   // 영문은 브랜드일 수 있어 실패
      labelNoDigits: true, // 이름에도 숫자 없음(restaurant.test.mjs)
      numberAllow: []      // 숫자는 하나도 안 된다
    }
  }
};

export function interestConfig(id) {
  const c = INTERESTS[id];
  if (!c) throw new Error(`알 수 없는 관심사: ${id} (가능: ${Object.keys(INTERESTS).join(', ')})`);
  return c;
}

// 경로에 맞는 본문 구역 표지. 없으면 {}
export function contentMarkers(cfg, url) {
  const { pathname } = new URL(url);
  const hit = (cfg.content || []).find(c => c.path.test(pathname));
  return hit ? { start: hit.start, end: hit.end } : {};
}
