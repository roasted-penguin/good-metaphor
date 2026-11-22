// 노드 파이프라인(T-194) 관심사별 출처 설정. 공식·공공 출처만(D-5): 위키·인벤·블로그는 넣지 않는다.
// - allowHost(host): 후보 노드 sources에 쓸 수 있는 호스트(check가 검사)
// - listings: 목록 페이지(index가 읽어 상세 페이지 링크를 모은다). linkPattern에 맞는 링크만, titleFilter가 있으면 제목도 맞아야.
//   stripQuery면 링크의 ?page=… 같은 꼬리를 떼고 본다(메이플 뉴스 목록)
// - seeds: 목록 없이 바로 넣는 상세 페이지(식당: 기존 그래프가 실제로 열어 확인한 공공 자료 + 사전)
// - content: 본문 구역 표지(경로 정규식 → { start, end }). 없으면 페이지 전체에서 머리·꼬리·메뉴를 뺀 글
// - sectionSkip: 긴 글을 절로 나눌 때(T-195) 건너뛸 절 제목 정규식(없으면 모두 초안)
// - rules: 사실 검사 규칙(규칙 2·기존 그래프 단위 테스트와 맞춘다)

const MAPLE = 'https://maplestory.nexon.com';

// 국가법령정보센터(T-198): 사람이 여는 주소(https://www.law.go.kr/법령/식품위생법)는 껍데기이고 조문은 스크립트가 lsInfoR.do로 불러온다.
// 껍데기에서 현행 판 번호(lsiSeq)·시행일(efYd)을 읽어 본문 주소를 만든다(판이 바뀌어도 씨앗 주소는 그대로). 출처 주소는 껍데기 주소를 쓴다
export function lawBodyUrl(html) {
  const s = String(html || '');
  const seq = s.match(/lsiSeq\s*[:=]\s*['"]?(\d+)/)?.[1];
  const ef = s.match(/efYd\s*=\s*['"](\d{8})['"]/)?.[1];
  if (!seq) return null;
  return `https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=${seq}${ef ? `&efYd=${ef}` : ''}&chrClsCd=010202&ancYnChk=0`;
}
const LAW = name => `https://www.law.go.kr/${encodeURI('법령/' + name)}`;
// 법령은 장 제목(제N장)으로 나누고, keep에 맞는 장만 초안한다. 하위 "제N절"은 상위 장을 따른다
const LAW_SUB = /^제\d+절/;

// 메이플 가이드 목록은 스크립트로 그려진다. T-207까지는 공식 가이드 검색을 주제어로 돌렸지만 쪽당 5개라 겹침이 많았다.
// T-208: 가이드 첫 화면 왼쪽 분류(Quickboard.articles)가 부르는 사이트 자체 목록 API(POST /guide/n23gameinformation/articles?boardId=…,
// robots 허용 경로)가 분류마다 글 전부를 준다(2026-11-23: 9분류 107글, 검색으로 모은 100글을 모두 포함). 글 번호·제목만 쓴다(본문 칸은 버림, D-5)
export const MAPLE_GUIDE_BOARDS = [
  [429467337, '기초 가이드'], [429467338, '성장'], [429467339, '아이템'], [429467340, '사냥/보스 컨텐츠'], [429467341, '스페셜 컨텐츠'],
  [429467342, '커뮤니티'], [429467343, '거래'], [429467344, '캐시 & 코디'], [429467345, '기타/TIP']
];
export const mapleBoardLinks = json => (Array.isArray(json?.list) ? json.list : [])
  .filter(x => /^\d+$/.test(String(x?.articleId ?? '')))
  .map(x => ({ url: `${MAPLE}/Guide/N23GameInformation/Articles/${x.articleId}`, text: String(x.title || '') }));

export const INTERESTS = {
  maplestory: {
    id: 'maplestory',
    domain: '메이플스토리',
    allowHost: h => h === 'maplestory.nexon.com',
    listings: [
      // 가이드 분류별 목록 API(T-208): 분류마다 POST 한 번
      ...MAPLE_GUIDE_BOARDS.map(([id]) => ({
        kind: 'guide',
        url: `${MAPLE}/guide/n23gameinformation/articles?boardId=${id}`,
        json: { body: {}, links: mapleBoardLinks },
        linkPattern: /^https:\/\/maplestory\.nexon\.com\/guide\/n23gameinformation\/articles\/\d+$/i
      })),
      { kind: 'guide', url: `${MAPLE}/Guide/N23GameInformation`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/guide\/n23gameinformation\/articles\/\d+$/i, paged: false },
      { kind: 'update', url: `${MAPLE}/News/Update?page={page}`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/news\/update\/\d+$/i, stripQuery: true },
      // 공지(T-207): 공지 분류만, 점검·오류·이벤트·결과 발표는 빼고 운영정책·월드 리프·보안 같은 제도 글만
      { kind: 'notice', url: `${MAPLE}/News/Notice/Notice?page={page}`, linkPattern: /^https:\/\/maplestory\.nexon\.com\/news\/notice\/notice\/\d+$/i, stripQuery: true,
        titleFilter: /운영정책|월드 리프|정책|보안|거래|이용 제한|제재|계정/, titleSkip: /오류|점검|이벤트|테스터|기부|휴무|결과 발표|보상 지급|개인정보/ }
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
      ].map(([title, mi, id]) => ({ kind: 'agency', title: `국세청 ${title}`, url: `https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=${mi}&cntntsId=${id}` })),
      // T-198 씨앗(2026-11-22 응답 확인, robots 허용). 생활법령(easylaw) 503·공정위 가맹사업거래(franchise.ftc.go.kr) 403·
      // 소상공인24(sbiz24.kr, 허용 호스트 밖)·식약처 게시판(첨부 파일 위주)은 넣지 않았다(보고서 T-198)
      // 법령: 국가법령정보센터 현행 법령에서 식당 운영에 닿는 장만
      ...[
        ['식품위생법', /영업|조리사|행정 제재/],
        ['가맹사업거래의 공정화에 관한 법률', /기본원칙|공정화|분쟁/],
        ['상가건물 임대차보호법', null],
        ['농수산물의 원산지 표시 등에 관한 법률', /원산지 표시 등$/],
        ['근로기준법', /근로계약|임금|근로시간/],
        ['최저임금법', /제2장 최저임금|최저임금의 결정/],
        ['부가가치세법', /간이과세/],
        ['외식산업 진흥법', /진흥기반|경쟁력/],
        ['식품 등의 표시ㆍ광고에 관한 법률', null],
        ['소상공인 보호 및 지원에 관한 법률', /창업 및 경영안정|백년소상공인/]
      ].map(([name, keep]) => ({ kind: 'law', title: `법령 ${name}`, url: LAW(name.replace(/ /g, '')), keep, keepSub: LAW_SUB, maxSections: 4 })),
      // 지자체 위생 안내: 동대문구 보건소(식품접객업 영업자가 실제로 보는 시설기준·준수사항·원산지·위생교육)
      ...[
        ['시설기준', 1305], ['영업자 준수사항', 1306], ['식품위생 교육', 1308], ['식중독 예방', 1309],
        ['영업자 지위승계', 1302], ['식품진흥기금 융자', 1307], ['음식점 원산지 관리', 1321]
      ].map(([title, key]) => ({ kind: 'local', title: `동대문구 보건소 ${title}`, url: `https://www.ddm.go.kr/health/contents.do?key=${key}` })),
      { kind: 'local', title: '송파구 식품안심업소 지정', url: 'https://www.songpa.go.kr/ehealth/contents.do?key=4637' },
      // 공정위 가맹 거래 안내, 최저임금위원회 제도·자주 묻는 질문, 국세청 카드·현금영수증·신규사업자
      { kind: 'agency', title: '공정위 가맹 거래질서 확립', url: 'https://www.ftc.go.kr/www/contents.do?key=706' },
      { kind: 'agency', title: '공정위 가맹사업법 위반행위 유형', url: 'https://www.ftc.go.kr/www/contents.do?key=345' },
      { kind: 'agency', title: '최저임금위원회 최저임금제도', url: 'https://www.minimumwage.go.kr/minWage/about/main.do' },
      { kind: 'agency', title: '최저임금위원회 자주 묻는 질문', url: 'https://www.minimumwage.go.kr/customer/faq/list.do' },
      ...[
        ['사업용 신용카드', 2475, 7799], ['현금영수증 발급의무', 2471, 7796], ['신규사업자', 11448, 8817], ['신용카드 결제거부·위장가맹점', 2476, 7800]
      ].map(([title, mi, id]) => ({ kind: 'agency', title: `국세청 ${title}`, url: `https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=${mi}&cntntsId=${id}` })),
      // T-207 씨앗: T-192(손 확장)가 다루는 노동·임대·가맹·카드 영역을 피해 세무 절차·주류 판매·다중이용업소 안전으로 넓힘(2026-11-23 응답 확인)
      ...[
        ['국세신고안내', 2224, 7664], ['근로·자녀장려금 신청자격', 2452, 7783], ['세무조사 유예 및 시기선택', 41126, 239081],
        ['개인사업자 정기조사 선정기준', 41021, 239050], ['체납액 특례제도', 41133, 239088], ['주류시장 진입 완화', 41131, 239086],
        ['영세납세자지원단', 135739, 109137], ['사업자 차명계좌 신고', 41122, 239077], ['세금계산서 발급의무 위반자 명단공개', 40981, 239041],
        ['종합소득세 가산세', 2228, 7668], ['성실신고확인제도', 2234, 7672], ['종합소득세 중간예납', 2236, 7673], ['부가가치세 가산세', 2276, 7697]
      ].map(([title, mi, id]) => ({ kind: 'agency', title: `국세청 ${title}`, url: `https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=${mi}&cntntsId=${id}` })),
      ...[
        // 화재배상책임보험 장은 T-192 후보라 남기지 않는다
        ['다중이용업소의 안전관리에 관한 특별법', /업소의 안전관리|화재위험평가/],
        ['주류 면허 등에 관한 법률', /판매/]
      ].map(([name, keep]) => ({ kind: 'law', title: `법령 ${name}`, url: LAW(name.replace(/ /g, '')), keep, keepSub: LAW_SUB, maxSections: 4 }))
    ],
    // 껍데기 페이지 → 실제 본문 주소(T-198). host가 같으면 resolve(html)를 불러 본문을 한 번 더 가져온다
    bodyFrom: [{ host: 'www.law.go.kr', resolve: lawBodyUrl }],
    // 조문 꼴 본문(T-205): 이름이 본문에 그대로 안 나와도 이름 핵심 낱말이 조문·장·조 제목에 있으면 "이름이 본문에 없음" 경고를 안 띄운다
    articleHosts: ['www.law.go.kr'],
    kindOrder: ['law', 'local', 'agency', 'press'],
    // 절 나누기(T-195): 본문 표지가 없는 공공 페이지는 메뉴·만족도 조사 제목도 절이 된다(농식품부 보도자료 5쪽에서 호출 10번 → 후보 0)
    // T-198: 지자체 누리집 꼬리(컨텐츠 정보·담당자), 법령 벌칙·부칙
    sectionSkip: /Skip Navigation|콘텐츠 만족도|바로가기|^보도자료$|사이트맵|전체메뉴|^메뉴$|^컨텐츠 (담당자 )?정보$|^제\d+장(의\d+)? 벌칙$|^부칙/i,
    content: [
      { path: /policyNewsView/, start: 'class="article_body"', end: 'class="article_footer"' },
      { path: /^\/LSW\/lsInfoR\.do$/, headingClasses: ['gtit'] }
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

// 경로에 맞는 본문 구역 표지(+ class 제목). 없으면 {}
export function contentMarkers(cfg, url) {
  const { pathname } = new URL(url);
  const hit = (cfg.content || []).find(c => c.path.test(pathname));
  if (!hit) return {};
  const out = {};
  if (hit.start) out.start = hit.start;
  if (hit.end) out.end = hit.end;
  if (hit.headingClasses) out.headingClasses = hit.headingClasses;
  return out;
}

// 껍데기 페이지면 실제 본문 주소, 아니면 null (T-198)
export function bodyUrlFor(cfg, url, html) {
  const host = new URL(url).hostname;
  const hit = (cfg.bodyFrom || []).find(b => b.host === host);
  return hit ? hit.resolve(html) : null;
}

// 색인 항목(JSON이라 정규식이 없음) → 같은 주소의 씨앗 설정(keep·keepSub·maxSections). 없으면 null
export function seedFor(cfg, url) {
  return (cfg.seeds || []).find(s => s.url === url) || null;
}

// 조문 꼴 출처(cfg.articleHosts, 식당 = 국가법령정보센터)인가 (T-205)
export function isArticleSource(url, cfg) {
  try { return (cfg?.articleHosts || []).includes(new URL(url).hostname); } catch { return false; }
}
