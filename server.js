/*
  책 유형 테스트 서비스용 로컬/배포 서버 (Node.js 기본 모듈만 사용, 별도 설치 불필요)

  실행 방법:
    node server.js
  그 다음 브라우저에서 http://localhost:3000 접속

  배포 시:
    - ALADIN_TTB_KEY는 아래처럼 환경변수로 넘기는 걸 권장 (코드에 하드코딩하지 않기)
      예) Windows: set ALADIN_TTB_KEY=발급받은키 && node server.js
      예) Render/Railway 등: 대시보드의 Environment Variables에 ALADIN_TTB_KEY 등록
    - 환경변수가 없으면 아래 FALLBACK_KEY를 사용함 (로컬 테스트 편의용, 배포 시엔 꼭 환경변수로 교체)

  용도:
  - index.html(책유형테스트_프로토타입.html)과 캐릭터 이미지(characters/*.png) 등 정적 파일 서빙
  - /aladin-api 요청을 받아 서버에서 TTBKey를 붙여 알라딘 Open API를 대신 호출
    (키가 클라이언트 JS에 노출되지 않음, 브라우저 CORS도 우회됨)
  - 동일한 도서 검색 결과는 메모리에 캐싱해서 알라딘 API 호출 횟수(일 5,000회 제한)를 아낌
*/

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HTML_FILE = '책유형테스트_프로토타입.html'; // 같은 폴더에 있어야 함
const FALLBACK_KEY = 'ttbfitcode000904001'; // 로컬 테스트용 기본값. 배포 시 ALADIN_TTB_KEY 환경변수로 덮어쓰기 권장
const ALADIN_TTB_KEY = process.env.ALADIN_TTB_KEY || FALLBACK_KEY;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// 표지 검색 결과 캐시: "쿼리|쿼리타입" -> cover URL(문자열) 또는 null(결과없음)
const coverCache = new Map();

function fetchAladin(query, queryType){
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ttbkey: ALADIN_TTB_KEY,
      Query: query,
      QueryType: queryType,
      MaxResults: '1',
      start: '1',
      SearchTarget: 'Book',
      output: 'js',
      Version: '20131101',
      Cover: 'Big',
    });
    const target = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?' + params.toString();
    https.get(target, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk) => (body += chunk));
      proxyRes.on('end', () => {
        let cover = null;
        let parseError = null;
        let data = null;
        try {
          data = JSON.parse(body);
          cover = (data.item && data.item[0] && data.item[0].cover) || null;
        } catch (e) { parseError = String(e); }
        resolve({ cover, raw: body.slice(0, 800), parseError, upstreamStatus: proxyRes.statusCode });
      });
    }).on('error', (err) => resolve({ cover: null, error: String(err) }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/aladin-api') {
    const query = url.searchParams.get('query') || '';
    const queryType = url.searchParams.get('queryType') || 'Keyword';
    const debug = url.searchParams.get('debug') === '1';
    const cacheKey = `${query}|${queryType}`;

    let result;
    if (coverCache.has(cacheKey) && !debug) {
      result = { cover: coverCache.get(cacheKey) };
    } else {
      result = await fetchAladin(query, queryType);
      coverCache.set(cacheKey, result.cover);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(debug ? result : { cover: result.cover }));
    return;
  }

  // 정적 파일 서빙 (기본은 프로토타입 HTML)
  let filePath = url.pathname === '/' ? HTML_FILE : '.' + decodeURIComponent(url.pathname);
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('파일을 찾을 수 없습니다: ' + filePath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(ALADIN_TTB_KEY === FALLBACK_KEY
    ? '[주의] ALADIN_TTB_KEY 환경변수가 없어서 코드 내 기본값을 쓰고 있음. 배포 전 환경변수로 교체할 것.'
    : '환경변수로 지정된 ALADIN_TTB_KEY 사용 중');
});
