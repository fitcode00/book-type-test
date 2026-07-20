/*
  48권 표지 이미지를 한 번만 미리 받아서 covers/ 폴더에 저장하고,
  covers.json에 코드별 경로를 기록하는 스크립트.
  + 알라딘 TTB(Thanks To Blogger) 제휴 구매링크도 함께 만들어 links.json에 저장.
    (구매 연결 → 24시간 내 구매시 판매가 약 3% 리베이트, 알라딘 공식 제휴 프로그램)

  왜 필요한가:
  알라딘 API는 Render 같은 해외/클라우드 서버 IP에서 호출하면 CloudFront가
  403으로 막아버림 (봇 차단 정책으로 추정). 근데 지금 이 컴퓨터(로컬)에서는
  잘 됨. 그래서 로컬에서 한 번 미리 받아 파일로 저장해두면,
  배포된 사이트는 매번 알라딘을 호출할 필요 없이 이 정적 파일만 쓰면 됨.
  (캐릭터 이미지를 로컬 파일로 바꾼 것과 같은 이유/방식)

  실행 방법:
    node fetch_covers.js
  끝나면 covers/ 폴더, covers.json, links.json이 생성/갱신됨.
  그 다음 GitHub에 covers 폴더, covers.json, links.json을 같이 올려야 함.
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

const ALADIN_TTB_KEY = process.env.ALADIN_TTB_KEY || 'ttbfitcode000904001';
const OUT_DIR = path.join(__dirname, 'covers');

const BOOKS = {
  FPWR: [['빨간 머리 앤', '루시 모드 몽고메리'], ['어서 오세요, 휴남동 서점입니다', '황보름'], ['빙과', '요네자와 호노부']],
  FPWD: [['작은 아씨들', '루이자 메이 올컷'], ['불편한 편의점', '김호연'], ['미움받을 용기', '기시미 이치로']],
  FPSR: [['레 미제라블', '빅토르 위고'], ['종의 기원', '정유정'], ['밤의 피크닉', '온다 리쿠']],
  FPSD: [['테스', '토마스 하디'], ['소년이 온다', '한강'], ['이처럼 사소한 것들', '클레어 키건']],
  FTWR: [['싯다르타', '헤르만 헤세'], ['죽고 싶지만 떡볶이는 먹고 싶어', '백세희'], ['달러구트 꿈 백화점', '이미예']],
  FTWD: [['어린 왕자', '생텍쥐페리'], ['가녀장의 시대', '이슬아'], ['왜 나는 너를 사랑하는가', '알랭 드 보통']],
  FTSR: [['지하로부터의 수기', '도스토옙스키'], ['쇼코의 미소', '최은영'], ['나미야 잡화점의 기적', '히가시노 게이고']],
  FTSD: [['이방인', '알베르 카뮈'], ['채식주의자', '한강'], ['피프티 피플', '정세랑']],
  GPWR: [['셜록 홈즈', '아서 코난 도일'], ['달러구트 꿈 백화점', '이미예'], ['죽고 싶지만 떡볶이는 먹고 싶어', '백세희']],
  GPWD: [['모모', '미하엘 엔데'], ['시선으로부터', '정세랑'], ['일간 이슬아', '이슬아']],
  GPSR: [['1984', '조지 오웰'], ['7년의 밤', '정유정'], ['용의자 X의 헌신', '히가시노 게이고']],
  GPSD: [['멋진 신세계', '올더스 헉슬리'], ['홀', '편혜영'], ['로드', '코맥 매카시']],
  GTWR: [['무소유', '법정'], ['나는 나로 살기로 했다', '김수현'], ['아몬드', '손원평']],
  GTWD: [['월든', '헨리 데이비드 소로'], ['불안', '알랭 드 보통'], ['야간 경비원의 일기', '정지돈']],
  GTSR: [['차라투스트라는 이렇게 말했다', '니체'], ['사피엔스', '유발 하라리'], ['28', '정유정']],
  GTSD: [['죄와 벌', '도스토옙스키'], ['예루살렘의 아이히만', '한나 아렌트'], ['밝은 밤', '최은영']]
};

function get(url){
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// 표지 URL과 함께 상품 itemId도 반환 (itemId가 있어야 TTB 제휴 구매링크를 만들 수 있음)
async function aladinCover(title, author){
  for (const queryType of ['Keyword', 'Title']) {
    const q = queryType === 'Keyword' ? `${title} ${author}` : title;
    const params = new URLSearchParams({
      ttbkey: ALADIN_TTB_KEY, Query: q, QueryType: queryType, MaxResults: '1',
      start: '1', SearchTarget: 'Book', output: 'js', Version: '20131101', Cover: 'Big'
    });
    const url = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?' + params.toString();
    try{
      const res = await get(url);
      if(res.status !== 200) continue;
      const data = JSON.parse(res.body.toString('utf-8'));
      const item = data.item && data.item[0];
      if(item && item.cover) return { cover: item.cover, itemId: item.itemId || null };
    }catch(e){ /* 다음 시도로 넘어감 */ }
  }
  return null;
}

// 알라딘 TTB(Thanks To Blogger) 제휴 구매링크 생성
// itemId가 있으면 해당 상품 페이지로 바로 연결, 없으면 검색결과 페이지로 연결 (둘 다 ttbkey로 추적됨)
function buildTTBLink(itemId, title){
  if (itemId) {
    return `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${itemId}&TTBKey=${ALADIN_TTB_KEY}`;
  }
  return `https://www.aladin.co.kr/search/wsearchresult.aspx?SearchTarget=Book&SearchWord=${encodeURIComponent(title)}&TTBKey=${ALADIN_TTB_KEY}`;
}

async function googleCover(title, author){
  const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
  try{
    const res = await get(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);
    if(res.status !== 200) return null;
    const data = JSON.parse(res.body.toString('utf-8'));
    const thumb = data.items && data.items[0] && data.items[0].volumeInfo.imageLinks && data.items[0].volumeInfo.imageLinks.thumbnail;
    return thumb ? thumb.replace('http:', 'https:') : null;
  }catch(e){ return null; }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function main(){
  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
  const manifest = {};
  const links = {};
  let ok = 0, fail = 0, linked = 0;

  for (const code of Object.keys(BOOKS)) {
    manifest[code] = [];
    links[code] = [];
    const books = BOOKS[code];
    for (let i = 0; i < books.length; i++) {
      const [title, author] = books[i];
      process.stdout.write(`[${code}-${i}] ${title} ... `);
      let result = await aladinCover(title, author); // { cover, itemId } | null
      let source = 'aladin';
      let coverUrl = result && result.cover;
      let itemId = result && result.itemId;

      if (!coverUrl) {
        coverUrl = await googleCover(title, author);
        source = 'google';
        itemId = null; // 구글 소스는 알라딘 itemId가 없음
      }

      // TTB 제휴 구매링크는 표지 성공 여부와 무관하게 항상 생성 (검색 fallback 포함)
      const ttbLink = buildTTBLink(itemId, title);
      links[code].push(ttbLink);
      if (itemId) linked++;

      if (!coverUrl) {
        console.log('실패 (표지 못 찾음)');
        manifest[code].push(null);
        fail++;
        await sleep(150);
        continue;
      }

      try {
        const imgRes = await get(coverUrl);
        const ext = coverUrl.includes('.png') ? 'png' : 'jpg';
        const filename = `${code}-${i}.${ext}`;
        fs.writeFileSync(path.join(OUT_DIR, filename), imgRes.body);
        manifest[code].push(`covers/${filename}`);
        console.log(`성공 (${source}) -> ${filename}`);
        ok++;
      } catch (e) {
        console.log('실패 (다운로드 오류)');
        manifest[code].push(null);
        fail++;
      }
      await sleep(150); // API 예의상 살짝 텀
    }
  }

  fs.writeFileSync(path.join(__dirname, 'covers.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  fs.writeFileSync(path.join(__dirname, 'links.json'), JSON.stringify(links, null, 2), 'utf-8');
  console.log(`\n완료: 표지 성공 ${ok}권, 실패 ${fail}권 / 상품 직결링크(itemId 있음) ${linked}권`);
  console.log('covers/ 폴더, covers.json, links.json이 생성됨. GitHub에 같이 올려줘.');
}

main();
